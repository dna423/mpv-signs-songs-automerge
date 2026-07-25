// ==============================================================================
// The Auto-Merger Dual Subtitle Engine
// Silently extracts tracks, mathematically scales canvases, and layers perfectly!
// ==============================================================================

var options = {
    // Optional: Fill this in if auto-detection fails or you want a custom binary location
	// example     ffmpeg_path: "C:/ffmpeg/bin/ffmpeg.exe" 
    ffmpeg_path: "" 
};

function notify(message, duration) {
    mp.osd_message(message, duration || 4);
}

// 1. Dynamic Path Resolution (~~/ points to active mpv directory)
var save_path = mp.command_native(["expand-path", "~~/Subs/"]);
if (save_path && !save_path.match(/[\\/]$/)) {
    save_path += "/";
}

// Ensure the Subs folder exists
mp.command_native_async({
    name: "subprocess",
    args: ["powershell", "-NoProfile", "-Command", "New-Item -ItemType Directory -Force -Path '" + save_path + "'"]
}, function() {});

// 2. FFmpeg Smart Probe Engine
function getFFmpegExecutable() {
    // Check 1: User explicitly defined a valid path in options
    if (options.ffmpeg_path && mp.utils && mp.utils.file_info(options.ffmpeg_path)) {
        return options.ffmpeg_path;
    }

    // Check 2: Check mpv portable folders (~~/utils/ffmpeg.exe, ~~/ffmpeg.exe, etc.)
    var candidates = [
        "~~/utils/ffmpeg.exe",
        "~~/ffmpeg.exe",
        "~~/utils/ffmpeg",
        "~~/ffmpeg"
    ];

    for (var i = 0; i < candidates.length; i++) {
        var expanded = mp.command_native(["expand-path", candidates[i]]);
        if (mp.utils && mp.utils.file_info(expanded)) {
            return expanded;
        }
    }

    // Check 3: Fall back to system PATH
    return "ffmpeg";
}

function mergeSubtitles() {
    var tracks = mp.get_property_native("track-list");
    var isCurrentlyMerged = false;
    var mergedTrackId = -1;

    for (var i = 0; i < tracks.length; i++) {
        if (tracks[i].type === "sub" && tracks[i].selected && tracks[i].external && 
            tracks[i]["external-filename"] && tracks[i]["external-filename"].indexOf("merged_live.ass") !== -1) {
            isCurrentlyMerged = true;
            mergedTrackId = tracks[i].id;
        }
    }

    if (isCurrentlyMerged) {
        mp.commandv("sub-remove", mergedTrackId);
        notify("Merged Subs Disabled! Restored default tracks.");
        return;
    }

    var sid = mp.get_property_number("sid");
    var secSid = mp.get_property_number("secondary-sid");

    if (!sid) {
        notify("Please select a Primary subtitle track first!");
        return;
    }

    // Auto-Detect Signs & Songs track if secondary track is unassigned
    if (!secSid) {
        for (var i = 0; i < tracks.length; i++) {
            if (tracks[i].type === "sub" && tracks[i].id !== sid) {
                var title = (tracks[i].title || "").toLowerCase();
                var extName = (tracks[i]["external-filename"] || "").toLowerCase();

                if (title.indexOf("sign") !== -1 || title.indexOf("song") !== -1 ||
                    extName.indexOf("sign") !== -1 || extName.indexOf("song") !== -1) {
                    secSid = tracks[i].id;
                    mp.set_property_number("secondary-sid", secSid);
                    notify("Auto-detected Signs track: " + (tracks[i].title || "Track " + secSid));
                    break;
                }
            }
        }
    }

    if (!secSid) {
        notify("No 'Signs' or 'Signs & Songs' track found. Please select manually!");
        return;
    }

    var pTrack = null, sTrack = null;
    var internalSubCount = 0;

    for (var i = 0; i < tracks.length; i++) {
        if (tracks[i].type === "sub") {
            if (tracks[i].id === sid) {
                pTrack = { external: tracks[i].external, filename: tracks[i]["external-filename"], si: internalSubCount };
            }
            if (tracks[i].id === secSid) {
                sTrack = { external: tracks[i].external, filename: tracks[i]["external-filename"], si: internalSubCount };
            }
            if (!tracks[i].external) internalSubCount++;
        }
    }

    if (!pTrack || !sTrack) return;

    var videoPath = mp.get_property("path");
    if (!videoPath || videoPath.indexOf("http") === 0) {
        notify("Cannot extract subs from a web stream!");
        return;
    }

    if (!videoPath.match(/^([a-zA-Z]:|[\\/])/)) {
        var wd = mp.get_property("working-directory");
        if (wd) videoPath = wd + "/" + videoPath;
    }

    var tempP = save_path + "temp_primary.ass";
    var tempS = save_path + "temp_secondary.ass";
    var mergedFile = save_path + "merged_live.ass";

    var ffmpegBin = getFFmpegExecutable();
    var ffmpegArgs = [ffmpegBin, "-y", "-v", "error"];
    var needsExtraction = false;
    var inputs = [];

    function addInput(path) {
        for (var idx = 0; idx < inputs.length; idx++) {
            if (inputs[idx] === path) return idx;
        }
        ffmpegArgs.push("-i", path);
        inputs.push(path);
        return inputs.length - 1;
    }

    // 1. Process Primary Track
    if (!pTrack.external) {
        var vIdx = addInput(videoPath);
        ffmpegArgs.push("-map", vIdx + ":s:" + pTrack.si, tempP);
        needsExtraction = true;
    } else {
        var isAssP = pTrack.filename && pTrack.filename.toLowerCase().indexOf(".ass") !== -1;
        if (!isAssP) {
            var pIdx = addInput(pTrack.filename);
            ffmpegArgs.push("-map", pIdx + ":0", tempP);
            needsExtraction = true;
        } else {
            tempP = pTrack.filename;
        }
    }

    // 2. Process Secondary Track
    if (!sTrack.external) {
        var vIdx = addInput(videoPath);
        ffmpegArgs.push("-map", vIdx + ":s:" + sTrack.si, tempS);
        needsExtraction = true;
    } else {
        var isAssS = sTrack.filename && sTrack.filename.toLowerCase().indexOf(".ass") !== -1;
        if (!isAssS) {
            var sIdx = addInput(sTrack.filename);
            ffmpegArgs.push("-map", sIdx + ":0", tempS);
            needsExtraction = true;
        } else {
            tempS = sTrack.filename;
        }
    }

    function executeMerge() {
        var pText = mp.utils.read_file(tempP);
        var sText = mp.utils.read_file(tempS);

        if (!pText || !sText) {
            notify("Failed to read subtitle files for merging.");
            return;
        }

        // 3. Calculate resolution canvas scaling ratio
        var getResY = function(txt) {
            var m = txt.match(/PlayResY:\s*(\d+)/i);
            return m ? parseFloat(m[1]) : 288;
        };
        var pResY = getResY(pText);
        var sResY = getResY(sText);
        var scale = sResY / pResY;

        var pStyles = [];
        var pEvents = [];
        var pLines = pText.split(/\r?\n/);
        var inStyles = false;
        var inEvents = false;
        var hasLayer = true; 

        for (var i = 0; i < pLines.length; i++) {
            var line = pLines[i].trim();
            if (line === "[V4+ Styles]") { inStyles = true; inEvents = false; continue; }
            if (line === "[Events]") { inEvents = true; inStyles = false; continue; }
            if (line.indexOf("[") === 0) { inStyles = false; inEvents = false; continue; }

            // 4. Process and scale Dialogue styles to match Signs canvas
            if (inStyles && line.indexOf("Style:") === 0) {
                var content = line.substring(6).trim();
                var parts = content.split(',');
                if (parts.length > 2) {
                    parts[0] = "Pri_" + parts[0].trim(); 
                    parts[2] = (parseFloat(parts[2]) * scale).toFixed(1); 
                    if (parts.length > 16) parts[16] = (parseFloat(parts[16]) * scale).toFixed(1); 
                    if (parts.length > 17) parts[17] = (parseFloat(parts[17]) * scale).toFixed(1); 
                    if (parts.length > 19) parts[19] = (parseFloat(parts[19]) * scale).toFixed(1); 
                    if (parts.length > 20) parts[20] = (parseFloat(parts[20]) * scale).toFixed(1); 
                    if (parts.length > 21) parts[21] = (parseFloat(parts[21]) * scale).toFixed(1); 
                    pStyles.push("Style: " + parts.join(','));
                }
            }

            if (inEvents && line.indexOf("Format:") === 0) {
                hasLayer = line.toLowerCase().indexOf("layer") !== -1;
            }

            // 5. Inject Layer, re-route styles, and scale internal positioning
            if (inEvents && line.indexOf("Dialogue:") === 0) {
                var content = line.substring(9).trim();
                
                if (!hasLayer) content = "0," + content; 
                
                var parts = content.split(',');
                if (parts.length >= 10) {
                    var dataCols = parts.slice(0, 9);
                    var textCol = parts.slice(9).join(',');
                    
                    dataCols[3] = "Pri_" + dataCols[3].trim(); 
                    
                    textCol = textCol.replace(/\\fs(\d+(?:\.\d+)?)/g, function(m, num) { return "\\fs" + (parseFloat(num) * scale).toFixed(1); });
                    textCol = textCol.replace(/\\pos\(([^,]+),([^\)]+)\)/g, function(m, x, y) { return "\\pos(" + (parseFloat(x) * scale).toFixed(1) + "," + (parseFloat(y) * scale).toFixed(1) + ")"; });
                    
                    pEvents.push("Dialogue: " + dataCols.join(',') + "," + textCol);
                }
            }
        }

        // 6. Inject scaled Dialogue cleanly into Signs file
        if (pStyles.length > 0) {
            sText = sText.replace(/(\[V4\+ Styles\][\s\S]*?)(?=\r?\n\[|$)/, "$1\n" + pStyles.join("\n"));
        }
        if (pEvents.length > 0) {
            sText = sText.replace(/(\[Events\][\s\S]*?)(?=\r?\n\[|$)/, "$1\n" + pEvents.join("\n"));
        }

        mp.utils.write_file("file://" + mergedFile, sText);
        mp.set_property("secondary-sid", "no");
        
        var vf = mp.get_property_native("vf") || [];
        for (var i = vf.length - 1; i >= 0; i--) {
            if (vf[i].label === "signs") vf.splice(i, 1);
        }
        mp.set_property_native("vf", vf);
        
        mp.commandv("sub-add", mergedFile);
        notify("Tracks Merged Perfectly! Canvas Sync Complete.");
    }

    if (needsExtraction) {
        notify("Processing Tracks... (This takes about 2 seconds)", 6);
        mp.command_native_async({ 
            name: "subprocess", 
            capture_stdout: true,
            capture_stderr: true,
            args: ffmpegArgs 
        }, function(success, result, error) {
            if (success && result && result.status === 0) {
                executeMerge();
            } else {
                var errCode = (result && result.status !== undefined) ? result.status : error;
                notify("FFmpeg Failed! Ensure FFmpeg is in PATH or mpv/utils/ (Err: " + errCode + ")", 8);
                print("[Dual Subs] FFmpeg stderr: " + (result && result.stderr ? result.stderr.trim() : "Unknown error"));
            }
        });
    } else {
        executeMerge();
    }
}

mp.add_key_binding("ctrl+s", "burn-secondary-subs", mergeSubtitles);
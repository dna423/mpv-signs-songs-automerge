// ==============================================================================
// The Auto-Merger Dual Subtitle Engine
// Silently extracts tracks, mathematically scales canvases, and layers perfectly!
// Includes Signs & Songs extraction mode (ctrl+shift+s), Instant JS Font Resizing (Shift+F / Shift+G),
// Universal F12 Audio Syncing, and Automatic Sub-Delay Baking on Merge.
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

// 2. Time Helper Functions for Timestamp Baking
function parseAssTimeToSeconds(str) {
    var m = (str || "").trim().match(/^(\d+):(\d+):(\d+)\.(\d+)$/);
    if (!m) return null;
    var hrs = parseInt(m[1], 10);
    var mins = parseInt(m[2], 10);
    var secs = parseInt(m[3], 10);
    var cs = parseInt(m[4], 10);
    var frac = m[4].length === 2 ? cs / 100 : cs / 1000;
    return hrs * 3600 + mins * 60 + secs + frac;
}

function secondsToAssTime(totalSecs) {
    if (totalSecs < 0) totalSecs = 0;
    var hrs = Math.floor(totalSecs / 3600);
    var rem = totalSecs % 3600;
    var mins = Math.floor(rem / 60);
    var secs = rem % 60;
    var wholeSecs = Math.floor(secs);
    var cs = Math.round((secs - wholeSecs) * 100);
    if (cs >= 100) { wholeSecs += 1; cs -= 100; }
    if (wholeSecs >= 60) { mins += 1; wholeSecs -= 60; }
    if (mins >= 60) { hrs += 1; mins -= 60; }
    var hrsStr = hrs.toString();
    var minsStr = (mins < 10 ? "0" : "") + mins;
    var secsStr = (wholeSecs < 10 ? "0" : "") + wholeSecs;
    var csStr = (cs < 10 ? "0" : "") + cs;
    return hrsStr + ":" + minsStr + ":" + secsStr + "." + csStr;
}

// 3. Universal F12 Audio Syncing Engine (Works on ANY Primary Subtitle Track)
function getFirstSubTimestampOfTrack(filePath) {
    if (!filePath) return null;
    try {
        var content = mp.utils.read_file(filePath);
        if (!content) return null;
        var lines = content.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('-->') !== -1) {
                var mSrt = line.split('-->')[0].trim().match(/(\d+):(\d+):(\d+)[.,](\d+)/);
                if (mSrt) return (parseInt(mSrt[1], 10) * 3600) + (parseInt(mSrt[2], 10) * 60) + parseInt(mSrt[3], 10) + (parseInt(mSrt[4], 10) / 1000);
            }
            if (line.indexOf('Dialogue:') === 0) {
                var parts = line.split(',');
                if (parts.length > 2) {
                    var mAss = parts[1].trim().match(/(\d+):(\d+):(\d+)\.(\d+)/);
                    if (mAss) {
                        var ms = parseInt(mAss[4], 10);
                        return (parseInt(mAss[1], 10) * 3600) + (parseInt(mAss[2], 10) * 60) + parseInt(mAss[3], 10) + ((mAss[4].length === 2 ? ms * 10 : ms) / 1000);
                    }
                }
            }
        }
    } catch(e) {}
    return null;
}

function syncFirstLineToCurrentPos() {
    var sid = mp.get_property_number("sid");
    if (!sid) {
        notify("Please select a Primary subtitle track first!");
        return;
    }

    var currentTime = mp.get_property_number("time-pos");
    if (currentTime === undefined || currentTime === null) return;

    var tracks = mp.get_property_native("track-list");
    var pTrack = null;
    if (tracks) {
        for (var i = 0; i < tracks.length; i++) {
            if (tracks[i].type === "sub" && tracks[i].id === sid) {
                pTrack = tracks[i];
                break;
            }
        }
    }

    var firstSubTime = null;
    if (pTrack && pTrack.external && pTrack["external-filename"]) {
        firstSubTime = getFirstSubTimestampOfTrack(pTrack["external-filename"]);
    }
    
    if (firstSubTime === null) {
        // Fallback to active cached Jimaku track or mpv sub-start property
        firstSubTime = getFirstSubTimestampOfTrack(save_path + "jimaku_live_track.ass") || 
                       getFirstSubTimestampOfTrack(save_path + "jimaku_live_track.srt") ||
                       mp.get_property_number("sub-start");
    }

    if (firstSubTime === null || firstSubTime === undefined) {
        notify("Sync failed: Could not determine first subtitle timestamp.");
        return;
    }

    var delay = currentTime - firstSubTime;
    mp.set_property_number("sub-delay", delay);
    notify("Primary Sub Synced (" + (delay > 0 ? "+" : "") + delay.toFixed(2) + "s)");
}

// 4. FFmpeg Smart Probe Engine
function getFFmpegExecutable() {
    if (options.ffmpeg_path && mp.utils && mp.utils.file_info(options.ffmpeg_path)) {
        return options.ffmpeg_path;
    }

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

    return "ffmpeg";
}

// Helper: Parse ASS Format: header line to get column indices
function parseAssFormat(line) {
    var cols = line.substring(line.indexOf(":") + 1).split(",");
    var map = { style: 3, text: 9 };
    for (var i = 0; i < cols.length; i++) {
        var c = cols[i].trim().toLowerCase();
        if (c === "style") map.style = i;
        if (c === "text") map.text = i;
    }
    return map;
}

// Helper: Check if text content matches sign patterns (ALL CAPS, dashes, title keywords)
function isTextSignLike(str) {
    var s = str.replace(/\{[^}]+\}/g, "").trim();
    if (!s) return false;

    if (/^[—\-\[\]\(\)\|\=○•★☆#]/i.test(s) || /[—\-\[\]\(\)\|\=○•★☆#]$/i.test(s)) return true;
    if (/\b(season|episode|ep\b|part|chapter|act)\b/i.test(s)) return true;

    var alphaOnly = s.replace(/[^a-zA-Z]/g, "");
    if (alphaOnly.length >= 4) {
        var upperCount = alphaOnly.replace(/[^A-Z]/g, "").length;
        if (upperCount / alphaOnly.length > 0.8) return true;
    }

    return false;
}

// Helper to determine if a secondary track event line is a Sign or Song
function isSignOrSongLine(line, formatMap) {
    if (line.indexOf("Dialogue:") !== 0) return true;
    
    var content = line.substring(9).trim();
    var parts = content.split(',');
    
    var styleIdx = (formatMap && formatMap.style !== undefined) ? formatMap.style : 3;
    var textIdx = (formatMap && formatMap.text !== undefined) ? formatMap.text : 9;

    if (parts.length <= styleIdx) return true;

    var styleName = (parts[styleIdx] || "").trim().toLowerCase();
    var textCol = parts.slice(textIdx).join(',');

    var hasExplicitSignTag = false;
    var signTagRegexes = [
        /\\pos\(/i, /\\move\(/i, /\\frz/i, /\\frx/i, /\\fry/i,
        /\\p[1-8]/i, /\\clip\(/i, /\\iclip\(/i, /\\org\(/i, /\\fax/i, /\\fay/i
    ];
    for (var i = 0; i < signTagRegexes.length; i++) {
        if (signTagRegexes[i].test(textCol)) {
            hasExplicitSignTag = true;
            break;
        }
    }

    if (styleName === "bottomcenter") {
        return hasExplicitSignTag;
    }

    if (styleName === "topcenter") {
        if (hasExplicitSignTag) return true;
        return isTextSignLike(textCol);
    }

    var dialogueStyleKeywords = ["main", "default", "flashback", "italic", "overlap", "dialogue", "top", "bottom", "narrator", "thought"];
    for (var i = 0; i < dialogueStyleKeywords.length; i++) {
        if (styleName.indexOf(dialogueStyleKeywords[i]) !== -1) {
            if (!hasExplicitSignTag) return false;
        }
    }

    var signStyleKeywords = ["sign", "title", "song", "lyric", "op", "ed", "insert", "typeset", "s&s", "logo", "chapter", "caption"];
    for (var i = 0; i < signStyleKeywords.length; i++) {
        if (styleName.indexOf(signStyleKeywords[i]) !== -1) return true;
    }

    if (hasExplicitSignTag) return true;

    var anMatch = textCol.match(/\\an([1-9])/);
    if (anMatch) {
        var anVal = parseInt(anMatch[1], 10);
        if (anVal !== 2 && anVal !== 8) return true;
    }

    return false;
}

// 5. Pure JavaScript Lightning-Fast Scaling Engine (~15ms)
function fastScaleAssInPlace(filePath, multiplier) {
    var text = mp.utils.read_file(filePath);
    if (!text) return false;

    var lines = text.split(/\r?\n/);
    var newLines = [];
    var inEvents = false;
    var styleIdx = 3;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var trimmed = line.trim();

        if (trimmed === "[Events]") {
            inEvents = true;
            newLines.push(line);
            continue;
        }
        if (trimmed.indexOf("[") === 0 && trimmed !== "[Events]") {
            inEvents = false;
        }

        if (line.indexOf("Style:") === 0) {
            var content = line.substring(6).trim();
            var parts = content.split(',');
            var styleName = parts[0].trim();

            if (styleName.indexOf("Sec_") !== 0 && styleName.indexOf("noresize") === -1) {
                if (parts.length > 2) {
                    parts[2] = Math.round(parseFloat(parts[2]) * multiplier).toString();
                    if (parts.length > 16) parts[16] = (parseFloat(parts[16]) * multiplier).toFixed(1);
                    if (parts.length > 17) parts[17] = (parseFloat(parts[17]) * multiplier).toFixed(1);
                    if (parts.length > 19) parts[19] = Math.round(parseFloat(parts[19]) * multiplier).toString();
                    if (parts.length > 20) parts[20] = Math.round(parseFloat(parts[20]) * multiplier).toString();
                    if (parts.length > 21) parts[21] = Math.round(parseFloat(parts[21]) * multiplier).toString();
                    line = "Style: " + parts.join(',');
                }
            }
        }

        if (inEvents && line.indexOf("Format:") === 0) {
            var fCols = line.substring(line.indexOf(":") + 1).split(",");
            for (var idx = 0; idx < fCols.length; idx++) {
                if (fCols[idx].trim().toLowerCase() === "style") styleIdx = idx;
            }
            newLines.push(line);
            continue;
        }

        if (inEvents && line.indexOf("Dialogue:") === 0) {
            var content = line.substring(9).trim();
            var parts = content.split(',');
            if (parts.length > styleIdx) {
                var lineStyle = parts[styleIdx].trim();
                if (lineStyle.indexOf("Sec_") !== 0 && lineStyle.indexOf("noresize") === -1) {
                    line = line.replace(/\\fs(\d+(?:\.\d+)?)/g, function(m, num) {
                        return "\\fs" + Math.round(parseFloat(num) * multiplier).toString();
                    });
                    line = line.replace(/\\bord(\d+(?:\.\d+)?)/g, function(m, num) {
                        return "\\bord" + (parseFloat(num) * multiplier).toFixed(1);
                    });
                    line = line.replace(/\\shad(\d+(?:\.\d+)?)/g, function(m, num) {
                        return "\\shad" + (parseFloat(num) * multiplier).toFixed(1);
                    });
                }
            }
        }

        newLines.push(line);
    }

    mp.utils.write_file("file://" + filePath, newLines.join("\n"));

    var tracks = mp.get_property_native("track-list");
    var baseName = filePath.replace(/^.*[\\/]/, "");
    var activeId = -1;
    if (tracks) {
        for (var t = 0; t < tracks.length; t++) {
            if (tracks[t].external && tracks[t].selected && tracks[t]["external-filename"] && tracks[t]["external-filename"].indexOf(baseName) !== -1) {
                activeId = tracks[t].id;
                break;
            }
        }
    }
    if (activeId !== -1) {
        mp.commandv("sub-remove", activeId);
    }
    mp.commandv("sub-add", filePath);
    return true;
}

function getActiveMergedTrackPath() {
    var tracks = mp.get_property_native("track-list");
    if (!tracks) return null;
    for (var i = 0; i < tracks.length; i++) {
        if (tracks[i].type === "sub" && tracks[i].selected && tracks[i].external && tracks[i]["external-filename"]) {
            var fn = tracks[i]["external-filename"];
            if (fn.indexOf("merged_live.ass") !== -1) return fn;
            if (fn.toLowerCase().indexOf(".ass") !== -1) {
                try {
                    var content = mp.utils.read_file(fn);
                    if (content && content.indexOf("Sec_") !== -1) return fn;
                } catch(e) {}
            }
        }
    }
    return null;
}

function isMergedTrackActive() {
    return getActiveMergedTrackPath() !== null;
}

function handleSmartScale(multiplier) {
    var activePath = getActiveMergedTrackPath();
    if (activePath) {
        fastScaleAssInPlace(activePath, multiplier);
        notify("Primary Subtitles Scaled!");
    } else {
        mp.commandv("add", "sub-scale", multiplier > 1 ? 0.1 : -0.1);
    }
}

function mergeSubtitles(signsOnly) {
    signsOnly = !!signsOnly;
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

    // Capture active sub-delay on Primary track to bake directly into Primary lines
    var primarySubDelay = mp.get_property_number("sub-delay") || 0;

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

        // 3. Filter secondary track if Signs & Songs mode is active
        if (signsOnly) {
            var sLines = sText.split(/\r?\n/);
            var filteredSLines = [];
            var sInEvents = false;
            var sFormatMap = { style: 3, text: 9 };

            for (var i = 0; i < sLines.length; i++) {
                var line = sLines[i];
                var trimmed = line.trim();

                if (trimmed.indexOf("Format:") === 0 && sInEvents) {
                    sFormatMap = parseAssFormat(trimmed);
                    filteredSLines.push(line);
                    continue;
                }

                if (trimmed === "[Events]") { sInEvents = true; filteredSLines.push(line); continue; }
                if (trimmed.indexOf("[") === 0 && trimmed !== "[Events]") { sInEvents = false; filteredSLines.push(line); continue; }

                if (sInEvents && trimmed.indexOf("Dialogue:") === 0) {
                    if (isSignOrSongLine(trimmed, sFormatMap)) {
                        filteredSLines.push(line);
                    }
                } else {
                    filteredSLines.push(line);
                }
            }
            sText = filteredSLines.join("\n");
        }

        // 4. Calculate resolution canvas scaling ratio
        var getResY = function(txt) {
            var m = txt.match(/PlayResY:\s*(\d+)/i);
            return m ? parseFloat(m[1]) : 288;
        };
        var pResY = getResY(pText);
        var sResY = getResY(sText);
        var scale = sResY / pResY;

        // 5. Prefix secondary track styles and dialogue lines with "Sec_"
        var sSecLines = sText.split(/\r?\n/);
        var sInStyles = false;
        var sInEvents2 = false;
        var sFormatMap2 = { style: 3, text: 9 };
        var newSLines = [];

        for (var i = 0; i < sSecLines.length; i++) {
            var line = sSecLines[i];
            var trimmed = line.trim();

            if (trimmed === "[V4+ Styles]") { sInStyles = true; sInEvents2 = false; newSLines.push(line); continue; }
            if (trimmed === "[Events]") { sInEvents2 = true; sInStyles = false; newSLines.push(line); continue; }
            if (trimmed.indexOf("[") === 0) { sInStyles = false; sInEvents2 = false; newSLines.push(line); continue; }

            if (sInStyles && trimmed.indexOf("Style:") === 0) {
                var content = trimmed.substring(6).trim();
                var parts = content.split(',');
                if (parts.length > 0) {
                    parts[0] = "Sec_" + parts[0].trim();
                    newSLines.push("Style: " + parts.join(','));
                } else {
                    newSLines.push(line);
                }
                continue;
            }

            if (sInEvents2 && trimmed.indexOf("Format:") === 0) {
                sFormatMap2 = parseAssFormat(trimmed);
                newSLines.push(line);
                continue;
            }

            if (sInEvents2 && trimmed.indexOf("Dialogue:") === 0) {
                var content = trimmed.substring(9).trim();
                var parts = content.split(',');
                if (parts.length > sFormatMap2.style) {
                    parts[sFormatMap2.style] = "Sec_" + parts[sFormatMap2.style].trim();
                    newSLines.push("Dialogue: " + parts.join(','));
                } else {
                    newSLines.push(line);
                }
                continue;
            }

            newSLines.push(line);
        }
        sText = newSLines.join("\n");

        // 6. Process and scale Primary Dialogue styles + bake primarySubDelay into timestamps
        var pStyles = [];
        var pEvents = [];
        var pLines = pText.split(/\r?\n/);
        var inStyles = false;
        var inEvents = false;
        var pFormatMap = { style: 3, text: 9 };
        var hasLayer = true; 

        for (var i = 0; i < pLines.length; i++) {
            var line = pLines[i].trim();
            if (line === "[V4+ Styles]") { inStyles = true; inEvents = false; continue; }
            if (line === "[Events]") { inEvents = true; inStyles = false; continue; }
            if (line.indexOf("[") === 0) { inStyles = false; inEvents = false; continue; }

            if (inStyles && line.indexOf("Style:") === 0) {
                var content = line.substring(6).trim();
                var parts = content.split(',');
                if (parts.length > 2) {
                    parts[2] = Math.round(parseFloat(parts[2]) * scale).toString();
                    if (parts.length > 16) parts[16] = (parseFloat(parts[16]) * scale).toFixed(1);
                    if (parts.length > 17) parts[17] = (parseFloat(parts[17]) * scale).toFixed(1);
                    if (parts.length > 19) parts[19] = Math.round(parseFloat(parts[19]) * scale).toString();
                    if (parts.length > 20) parts[20] = Math.round(parseFloat(parts[20]) * scale).toString();
                    if (parts.length > 21) parts[21] = Math.round(parseFloat(parts[21]) * scale).toString();
                    pStyles.push("Style: " + parts.join(','));
                }
            }

            if (inEvents && line.indexOf("Format:") === 0) {
                hasLayer = line.toLowerCase().indexOf("layer") !== -1;
                pFormatMap = parseAssFormat(line);
            }

            if (inEvents && line.indexOf("Dialogue:") === 0) {
                var content = line.substring(9).trim();
                if (!hasLayer) content = "0," + content; 
                
                var parts = content.split(',');
                if (parts.length >= 10) {
                    // Bake active primary sub delay into Primary Dialogue Start and End timestamps
                    if (primarySubDelay !== 0) {
                        var startSec = parseAssTimeToSeconds(parts[1]);
                        var endSec = parseAssTimeToSeconds(parts[2]);
                        if (startSec !== null && endSec !== null) {
                            parts[1] = secondsToAssTime(startSec + primarySubDelay);
                            parts[2] = secondsToAssTime(endSec + primarySubDelay);
                        }
                    }

                    var dataCols = parts.slice(0, 9);
                    var textCol = parts.slice(9).join(',');
                    
                    textCol = textCol.replace(/\\fs(\d+(?:\.\d+)?)/g, function(m, num) { return "\\fs" + (parseFloat(num) * scale).toFixed(1); });
                    textCol = textCol.replace(/\\pos\(([^,]+),([^\)]+)\)/g, function(m, x, y) { return "\\pos(" + (parseFloat(x) * scale).toFixed(1) + "," + (parseFloat(y) * scale).toFixed(1) + ")"; });
                    
                    pEvents.push("Dialogue: " + dataCols.join(',') + "," + textCol);
                }
            }
        }

        // 7. Inject scaled Primary Dialogue cleanly into Secondary file
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
        mp.set_property_number("sub-delay", 0); // Reset mpv global sub delay to 0 once baked!
        
        var msg = signsOnly ? "Merged & Filtered" : "Merged";
        if (primarySubDelay !== 0) {
            msg += " & retimed";
        }
        notify(msg);
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

mp.add_key_binding("f12", "dual-subs-sync-primary", syncFirstLineToCurrentPos);
mp.add_key_binding("ctrl+s", "burn-secondary-subs", function() { mergeSubtitles(false); });
mp.add_key_binding("ctrl+shift+s", "burn-secondary-signs-only", function() { mergeSubtitles(true); });

// Overwrite mpv's Shift+F / Shift+G keybindings for instant pure JS primary sub scaling when merged
mp.add_key_binding("G", "dual-subs-scale-up", function() { handleSmartScale(1.15); });
mp.add_key_binding("F", "dual-subs-scale-down", function() { handleSmartScale(0.85); });

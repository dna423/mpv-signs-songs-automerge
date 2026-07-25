#Vibecoded disclaimer

# mpv-signs-songs-automerge
An mpv script that lets you merge primary subs with a secondary signs/songs/karaoke track without breaking typesetting or positioning. If no Secondary Subtitle track is selected, it searches automatically for a signs or songs track.

Usage:

Press ctrl+s to merge the secondary and primary subtitle file. If secondary subtitle is empty then the script will look for a track called signs or signs&songs.





## Requirements
Put Dual_subs.js inside AppData\Roaming\mpv\scripts or windows+r to open run and paste %appdata%\mpv\scripts.

This script requires **FFmpeg** to extract and merge subtitle tracks.

### Easy Setup Options (Pick One):

**Option A: Automated Install (Recommended)**
Open your terminal and run:
* **Windows:** `winget install -e --id Gyan.FFmpeg`
* **macOS:** `brew install ffmpeg`
* **Linux:** `sudo apt install ffmpeg`

**Option B: Portable / No-Install**
1. Download `ffmpeg.exe` from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/).
2. Drop `ffmpeg.exe` into a `utils` folder inside your mpv directory:  
   `C:\Users\<YourName>\AppData\Roaming\mpv\utils\ffmpeg.exe`

**Option C: Manually set a Path in dual_subs.js
1. Open Dual_subs.js with a text editor (notepad/notepad++)
2. Look for ffmpeg_path: "" and put a path inside the brackets (e.g.) ffmpeg_path: "C:/ffmpeg/bin/ffmpeg.exe"

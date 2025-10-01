# YouTube CD Maker

This project bundles a small Express server and static front end for building a "CD" playlist out of YouTube audio. The application depends on external binaries (`yt-dlp`, `ffmpeg`, and `zip`) for probing videos, transcoding audio, and packaging downloads.

## Debugging failed MP3/WAV downloads

If adding tracks works but one-off MP3/WAV downloads fail, collect the following information:

1. **Check binary availability** – Visit [`/api/diag`](http://localhost:3000/api/diag) while the server is running. The JSON response lists the detected executables and the versions that were found. A missing `ffmpeg` or `yt-dlp` entry means the server could not locate the tool.
2. **Inspect the server log** – The server logs `[convert]` entries to the console. Failures include the underlying `yt-dlp` or `ffmpeg` message, which is the quickest way to see why a conversion stopped.
3. **Reproduce with curl** – Issue a manual request to capture the raw error payload:
   ```bash
   curl -v -H 'Content-Type: application/json' \
     -d '{"url":"<VIDEO_URL>","target":"mp3"}' \
     http://localhost:3000/api/convert
   ```
   Replace `<VIDEO_URL>` with the YouTube link you are testing. The JSON response includes the chosen format, available formats, and the extractor client that was used.

### Keeping `yt-dlp` and `ffmpeg` current

* `yt-dlp` – Update with `python3 -m pip install -U yt-dlp` (or `brew install yt-dlp` on macOS, `scoop install yt-dlp` on Windows). Confirm the new version with `yt-dlp --version`.
* `ffmpeg` – Install via your package manager (e.g. `brew install ffmpeg`, `choco install ffmpeg`, `apt-get install ffmpeg`). Check the version with `ffmpeg -version`.

Restart the Node server after upgrading either binary so the new paths are detected.

### Troubleshooting tips

* On systems where `ffmpeg` is not globally accessible, set the `FFMPEG_PATH` environment variable to the absolute path of the binary before starting the server. The server forwards this location to `yt-dlp` as well as its own transcoding steps.
* If `yt-dlp` struggles with a specific video, pass additional extractor options via `YTDLP_EXTRA` or `YTDLP_EXTRACTOR_ARGS` (see `server.js` for details). Adding `--force-ipv4` helps on restrictive networks.
* When YouTube's SABR protection blocks cloud or VPS traffic, supply authenticated cookies by either pointing `COOKIES_PATH` at a Netscape-format cookie file or inlining the file via `COOKIES_TEXT`/`COOKIES_BASE64`. The server materializes the cookies and reuses them for all `yt-dlp` calls while probing and downloading.
* The backend now prefers the YouTube TV extractor client (with a fallback to mobile/desktop clients) when negotiating formats, which avoids the most common SABR blocks without affecting thumbnail handling.

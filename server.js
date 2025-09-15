// server.js — backend for probe, Add To CD, and one-off MP3/WAV download
// Node 18+/20+/22, package.json has "type":"module"

import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// --------------------------- App setup ---------------------------
const app  = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const TMP_DIR = path.join(__dirname, "tmp");
await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
await fsp.mkdir(TMP_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOAD_DIR));

// Capacity (80-minute CD)
const CAP_SECONDS = 80 * 60;
let playlist = []; // { id, title, duration, filepath, sizeBytes }

// ------------------------- Helpers -------------------------------
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    const p = spawn(cmd, args, { ...opts });
    p.stdout?.on("data", d => stdout += d.toString());
    p.stderr?.on("data", d => stderr += d.toString());
    p.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function detectCommand(cmd) {
  for (const flag of [["--version"], ["-version"], ["-V"], []]) {
    const { code } = await run(cmd, flag);
    if (code === 0) return { ok: true, cmd, tried: flag };
  }
  return { ok: false, cmd };
}

async function detectYtDlp() {
  const candidates = [
    process.env.YTDLP_PATH,
    "yt-dlp", "yt-dlp.exe",
    "python", "py"
  ].filter(Boolean);

  for (const c of candidates) {
    const det = await detectCommand(c);
    if (!det.ok) continue;
    if (c === "python" || c === "py") {
      const prob = await run(c, ["-m", "yt_dlp", "--version"]);
      if (prob.code === 0) return { bin: c, mode: "python" };
      continue;
    }
    const ver = await run(c, ["--version"]);
    if (ver.code === 0) return { bin: c, mode: "direct", version: ver.stdout.trim() || ver.stderr.trim() };
  }
  return { bin: null, mode: null };
}

async function detectFfmpeg() {
  const candidate = process.env.FFMPEG_PATH || "ffmpeg";
  const det = await detectCommand(candidate);
  if (!det.ok) return { bin: null };
  const ver = await run(candidate, ["-version"]);
  return { bin: candidate, version: (ver.stdout || ver.stderr).split("\n")[0] };
}

const FF = await detectFfmpeg();
const YD = await detectYtDlp();

function requireBinsOrThrow() {
  if (!FF.bin) throw new Error("ffmpeg not found. Set FFMPEG_PATH env var to its full path.");
  if (!YD.bin) throw new Error("yt-dlp not found. Install it or set YTDLP_PATH env var.");
}

function runYtDlp(args, opts = {}) {
  if (YD.mode === "python") return spawn(YD.bin, ["-m", "yt_dlp", ...args], opts);
  return spawn(YD.bin, args, opts);
}

function sumDuration() {
  return playlist.reduce((acc, t) => acc + (t.duration || 0), 0);
}

const COOKIES_PATH  = process.env.COOKIES_PATH || null;
// You may force a client via env, e.g. YTDLP_EXTRACTOR_ARGS="youtube:player_client=web"
const EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || "";
const YTDLP_EXTRA    = process.env.YTDLP_EXTRA || "--force-ipv4"; // helps on some networks

function safeBase(title) {
  const s = String(title || "audio")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return s || "audio";
}

// ---------- Metadata ----------
async function getVideoMetaDetailed(url, clientArg /* "youtube:player_client=web" | "" */) {
  requireBinsOrThrow();
  const args = ["-J", "--no-playlist", "--skip-download"];
  if (COOKIES_PATH) args.push("--cookies", COOKIES_PATH);
  if (clientArg && clientArg.trim()) args.push("--extractor-args", clientArg);
  if (YTDLP_EXTRA) args.push(...YTDLP_EXTRA.split(" ").filter(Boolean));
  args.push(url);

  const { code, stdout, stderr } = await new Promise((resolve) => {
    const p = runYtDlp(args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => resolve({ code: -1, stdout: "", stderr: String(e) }));
    p.on("close", (c) => resolve({ code: c, stdout: out, stderr: err }));
  });

  if (code !== 0) return { ok: false, error: "yt-dlp failed", code, stdout, stderr, usedClient: clientArg || null };

  try {
    const meta = JSON.parse(stdout);
    return { ok: true, meta, stdout, stderr, usedClient: clientArg || null };
  } catch {
    return { ok: false, error: "JSON parse failed", code, stdout, stderr, usedClient: clientArg || null };
  }
}

// Try clients in parallel; prefer first that yields audio-only (>=44.1k) by priority order,
// else the richest success; else first failure.
async function getVideoMetaSmart(url) {
  if (EXTRACTOR_ARGS) return getVideoMetaDetailed(url, EXTRACTOR_ARGS);

  const clients = ["youtube:player_client=web", "youtube:player_client=ios", "youtube:player_client=android", ""];
  const promises = clients.map(c => getVideoMetaDetailed(url, c));
  const results  = await Promise.all(promises);

  const hasAudioOnlyHi = (meta) => {
    const formats = Array.isArray(meta?.formats) ? meta.formats : [];
    return formats.some(f =>
      String(f?.vcodec || "").toLowerCase() === "none" &&
      f?.acodec && f.acodec !== "none" &&
      (Number(f.asr) || 0) >= 44100
    );
  };

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.ok && hasAudioOnlyHi(r.meta)) return r;
  }

  const oks = results.filter(r => r.ok);
  if (oks.length) {
    oks.sort((a, b) => (b.meta?.formats?.length || 0) - (a.meta?.formats?.length || 0));
    return oks[0];
  }
  return results[0];
}

// ---------- Best format picker (Opus > AAC, audio-only, >=44.1k) ----------
function chooseBestFormat(formatsRaw) {
  const norm = (f) => ({
    ...f,
    abr: (f.abr ?? (f.tbr ? Math.round(f.tbr) : undefined)),
    asr: (typeof f.asr === "string" ? parseInt(f.asr, 10) : f.asr),
    vcodec: (f.vcodec || "").toLowerCase(),
    acodec: (f.acodec || "").toLowerCase(),
  });

  const all = (formatsRaw || [])
    .filter(f => f && f.acodec && f.acodec !== "none")
    .map(norm);

  const audioOnly = all.filter(f => f.vcodec === "none");
  const hiAudioOnly = audioOnly.filter(f => (f.asr || 0) >= 44100);

  const isOpus = f => f.acodec.includes("opus");
  const isAac  = f => f.acodec.includes("aac") || f.acodec.includes("mp4a");
  const byBitrate = (a, b) => (b.abr || 0) - (a.abr || 0) || (b.tbr || 0) - (a.tbr || 0);

  const pick = (arr, pred) => arr.filter(pred).sort(byBitrate)[0];

  return (
    pick(hiAudioOnly, isOpus) ||
    pick(hiAudioOnly, isAac)  ||
    pick(hiAudioOnly, () => true) ||
    null
  );
}

function pickThumbnail(meta) {
  if (!meta) return null;
  if (typeof meta.thumbnail === "string") return meta.thumbnail;
  const arr = meta.thumbnails || meta.thumbnail || [];
  if (Array.isArray(arr) && arr.length) {
    return arr.slice().sort((a, b) => (b.width||0)*(b.height||0) - (a.width||0)*(a.height||0))[0].url || null;
  }
  return null;
}

// ---------- Download & transcode ----------
async function downloadSourceToTmp(url, formatId, clientArg /* pass-through */) {
  requireBinsOrThrow();
  const outTmpl = path.join(TMP_DIR, "%(title)s-%(id)s.%(ext)s");
  const args = [];
  if (formatId) args.push("-f", String(formatId));
  if (COOKIES_PATH) args.push("--cookies", COOKIES_PATH);
  if (clientArg && clientArg.trim()) args.push("--extractor-args", clientArg);
  if (YTDLP_EXTRA) args.push(...YTDLP_EXTRA.split(" ").filter(Boolean));
  args.push(
    "--no-playlist",
    "--restrict-filenames",
    "-o", outTmpl,
    "--print", "after_move:filepath",
    url
  );
  const { code, stdout, stderr } = await run(
    YD.mode === "python" ? YD.bin : YD.bin,
    (YD.mode === "python" ? ["-m","yt_dlp"] : []).concat(args)
  );
  if (code !== 0) throw new Error(`yt-dlp download failed: ${stderr}`);
  const file = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!file || !fs.existsSync(file)) throw new Error("Downloaded file not found");
  return file;
}

async function transcodeToMp3V0(inputPath) {
  const id = nanoid(8);
  const out = path.join(TMP_DIR, `${id}.mp3`);
  const args = ["-y", "-i", inputPath, "-vn", "-c:a", "libmp3lame", "-q:a", "0", out];
  const { code, stderr } = await run(FF.bin, args);
  if (code !== 0 || !fs.existsSync(out)) throw new Error(`ffmpeg mp3 failed: ${stderr}`);
  return out;
}

async function transcodeToWav4416(inputPath) {
  const id = nanoid(8);
  const out = path.join(TMP_DIR, `${id}.wav`);
  const args = ["-y", "-i", inputPath, "-vn", "-ar", "44100", "-ac", "2", "-sample_fmt", "s16", out];
  const { code, stderr } = await run(FF.bin, args);
  if (code !== 0 || !fs.existsSync(out)) throw new Error(`ffmpeg wav failed: ${stderr}`);
  return out;
}

function streamAndUnlink(res, filePath, downloadName) {
  const mime = filePath.endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
  const rs = fs.createReadStream(filePath);
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
  rs.pipe(res);
  rs.on("close", async () => {
    try { await fsp.unlink(filePath); } catch {}
  });
}

// --------------------------- Routes ------------------------------
app.get("/api/diag", async (_req, res) => {
  res.json({ ffmpeg: FF, ytdlp: YD });
});

app.get("/api/list", (_req, res) => {
  res.json({
    capSeconds: CAP_SECONDS,
    totalSeconds: sumDuration(),
    items: playlist.map(({ id, title, duration, sizeBytes }) => ({ id, title, duration, sizeBytes }))
  });
});

app.post("/api/clear", async (_req, res) => {
  await Promise.allSettled(playlist.map(t => fsp.unlink(t.filepath).catch(()=>{})));
  playlist = [];
  res.json({ ok: true });
});

app.post("/api/remove/:id", async (req, res) => {
  const idx = playlist.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  try { await fsp.unlink(playlist[idx].filepath); } catch {}
  playlist.splice(idx, 1);
  res.json({ ok: true, totalSeconds: sumDuration() });
});

app.get("/api/file/:id", (req, res) => {
  const item = playlist.find(t => t.id === req.params.id);
  if (!item) return res.status(404).end();
  res.download(item.filepath, path.basename(item.filepath));
});

// Probe: supports { fast: true } for quickest title/duration via web client
app.post("/api/probe", async (req, res) => {
  const { url, fast } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid URL" });
  try {
    const r = fast
      ? await getVideoMetaDetailed(url, "youtube:player_client=web")
      : await getVideoMetaSmart(url);
    if (!r.ok) return res.status(400).json({ error: "Failed to read metadata", detail: r.error, code: r.code, stderr: r.stderr });

    const meta = r.meta;
    const audioFormats = (meta.formats || [])
      .filter(f => f && f.acodec && f.acodec !== "none")
      .map(f => ({
        id: f.format_id,
        ext: f.ext,
        acodec: f.acodec,
        vcodec: f.vcodec,
        abr: f.abr ?? (f.tbr ? Math.round(f.tbr) : undefined),
        asr: f.asr,
        filesize: f.filesize || f.filesize_approx || null,
        tbr: f.tbr || null,
        note: f.format_note || ""
      }));

    const best = chooseBestFormat(audioFormats);
    const thumb = pickThumbnail(meta);

    res.json({
      id: meta.id,
      title: meta.title,
      duration: meta.duration,
      thumbnail: thumb,
      bestFormat: best,
      audioFormats,
      usedClient: r.usedClient || null
    });
  } catch (e) {
    res.status(500).json({ error: "Probe crashed", message: String(e?.message || e) });
  }
});

// Add to the CD list (stores MP3 file to /downloads and updates the playlist)
app.post("/api/add", async (req, res) => {
  const { url, quality, format_id, client_token, used_client } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid URL" });

  const metaR = await getVideoMetaSmart(url);
  if (!metaR.ok || !metaR.meta?.duration) {
    return res.status(400).json({ error: "Failed to read video metadata", detail: metaR.error, stderr: metaR.stderr });
  }

  try {
    const q = (quality || "").toLowerCase();
    const audioQuality = (q === "320" || q === "320k") ? "320K" : "0"; // default V0
    const args = [];

    const clientArg = used_client || metaR.usedClient || "";
    if (clientArg && clientArg.trim()) args.push("--extractor-args", clientArg);
    if (COOKIES_PATH) args.push("--cookies", COOKIES_PATH);
    if (YTDLP_EXTRA)  args.push(...YTDLP_EXTRA.split(" ").filter(Boolean));

    const looksLikePath = FF.bin && (FF.bin.startsWith("/") || FF.bin.includes("\\") || /^[A-Za-z]:\\/.test(FF.bin));
    if (looksLikePath) args.push("--ffmpeg-location", FF.bin);

    if (format_id) args.push("-f", String(format_id));

    args.push(
      "-x", "--audio-format", "mp3",
      "--audio-quality", audioQuality,
      "--no-playlist",
      "--restrict-filenames",
      "-o", path.join(DOWNLOAD_DIR, "%(title)s-%(id)s.%(ext)s"),
      "--print", "after_move:filepath",
      url
    );

    const { code, stdout, stderr } = await run(
      YD.mode === "python" ? YD.bin : YD.bin,
      (YD.mode === "python" ? ["-m","yt_dlp"] : []).concat(args)
    );
    if (code !== 0) throw new Error(`yt-dlp exit ${code}: ${stderr}`);

    const file = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    const stat = await fsp.stat(file);
    const item = {
      id: nanoid(8),
      title: metaR.meta.title || path.basename(file),
      duration: Number(metaR.meta.duration) || 0,
      filepath: file,
      sizeBytes: stat.size
    };
    playlist.push(item);
    res.json({
      item: { id: item.id, title: item.title, duration: item.duration, sizeBytes: item.sizeBytes },
      totalSeconds: sumDuration(),
      capSeconds: CAP_SECONDS,
      client_token
    });
  } catch (e) {
    console.error("[add] error:", e?.message || e);
    res.status(500).json({ error: "Convert failed", message: String(e?.message || e) });
  }
});

// One-off conversion endpoint (MP3 or WAV) that streams a download
app.post("/api/convert", async (req, res) => {
  const { url, target, format_id, used_client } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid URL" });
  const tgt = String(target || "").toLowerCase();
  if (!["mp3", "wav"].includes(tgt)) return res.status(400).json({ error: "Invalid target (mp3|wav)" });

  let dbgFormats = null, chosenFmt = null, clientArg = used_client || null, metaTitle = null;

  try {
    const r = await getVideoMetaSmart(url);
    if (!r.ok) {
      return res.status(400).json({
        error: "Failed to read metadata",
        detail: r.error, code: r.code, stderr: r.stderr
      });
    }
    metaTitle = r.meta?.title || null;
    clientArg = clientArg || r.usedClient || "";

    const candidates = (r.meta.formats || [])
      .map(f => ({
        id: f.format_id, ext: f.ext, acodec: f.acodec, vcodec: f.vcodec,
        abr: f.abr ?? (f.tbr ? Math.round(f.tbr) : undefined),
        asr: f.asr, tbr: f.tbr, note: f.format_note || ""
      }))
      .filter(f => f.acodec && f.acodec !== "none");
    dbgFormats = candidates;

    let fmtId = format_id;
    if (!fmtId) {
      const best = chooseBestFormat(candidates);
      if (!best) {
        return res.status(400).json({
          error: "No suitable audio-only format ≥44.1 kHz found",
          picker: "audio-only (vcodec=none) & asr>=44100; priority opus > aac > other by bitrate",
          formats: dbgFormats,
          usedClient: clientArg || null
        });
      }
      fmtId = best.id;
      chosenFmt = best;
    } else {
      chosenFmt = dbgFormats.find(f => String(f.id) === String(fmtId)) || null;
    }

    console.log("[convert] target=%s fmtId=%s client=%s url=%s", tgt, fmtId, clientArg || "(default)", url);

    const src = await downloadSourceToTmp(url, fmtId, clientArg);

    let out;
    if (tgt === "mp3") {
      out = await transcodeToMp3V0(src);      // VBR V0 (best from lossy source)
    } else {
      out = await transcodeToWav4416(src);    // 44.1kHz/16-bit (CD)
    }
    try { await fsp.unlink(src); } catch {}

    const base = safeBase(metaTitle);
    const downloadName = `${base}.${tgt}`;
    streamAndUnlink(res, out, downloadName);

  } catch (e) {
    console.error("[convert] error:", e?.message || e);
    res.status(500).json({
      error: "Convert failed",
      message: String(e?.message || e),
      chosen: chosenFmt ? {
        id: chosenFmt.id, acodec: chosenFmt.acodec, vcodec: chosenFmt.vcodec,
        asr: chosenFmt.asr, abr: chosenFmt.abr, ext: chosenFmt.ext
      } : null,
      formats: dbgFormats || null,
      usedClient: clientArg || null
    });
  }
});

// -------------------------- Start -------------------------------
app.listen(PORT, () => {
  console.log(`▶ Listening on http://localhost:${PORT}`);
  console.log(`FFmpeg: ${FF.bin || "NOT FOUND"}`);
  console.log(`yt-dlp: ${YD.bin || "NOT FOUND"} ${YD.mode ? `(mode: ${YD.mode})` : ""}`);
});

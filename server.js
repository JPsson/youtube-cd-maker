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
const config = {
  port: Number(process.env.PORT) || 3000,
  capSeconds: 80 * 60,
  downloadDir: path.join(__dirname, "downloads"),
  tmpDir: path.join(__dirname, "tmp"),
};

await fsp.mkdir(config.downloadDir, { recursive: true });
await fsp.mkdir(config.tmpDir, { recursive: true });

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(config.downloadDir));

class PlaylistStore {
  constructor(capSeconds) {
    this.capSeconds = capSeconds;
    this.items = [];
  }

  get totalSeconds() {
    return this.items.reduce((acc, t) => acc + (t.duration || 0), 0);
  }

  add(item) {
    this.items.push(item);
  }

  remove(id) {
    const idx = this.items.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const [removed] = this.items.splice(idx, 1);
    return removed;
  }

  clear() {
    const cleared = this.items.slice();
    this.items.length = 0;
    return cleared;
  }

  find(id) {
    return this.items.find((t) => t.id === id) || null;
  }

  reorder(orderIds) {
    if (!Array.isArray(orderIds)) return false;
    if (orderIds.length !== this.items.length) return false;

    const uniq = new Set(orderIds);
    if (uniq.size !== orderIds.length) return false;

    const map = new Map(this.items.map((item) => [item.id, item]));
    if (orderIds.some((id) => !map.has(id))) return false;

    const next = orderIds.map((id) => map.get(id));
    this.items.splice(0, this.items.length, ...next);
    return true;
  }

  toJSON() {
    return {
      capSeconds: this.capSeconds,
      totalSeconds: this.totalSeconds,
      items: this.items.map(({ id, title, duration, sizeBytes, videoId, thumbnail }) => ({
        id,
        title,
        duration,
        sizeBytes,
        videoId: videoId || null,
        thumbnail: thumbnail || null,
      })),
    };
  }
}

const playlistStore = new PlaylistStore(config.capSeconds);

const canceledAddTokens = new Map();
const CANCELED_TOKEN_TTL = 1000 * 60 * 15; // 15 minutes

const addProgressMap = new Map();
const ADD_PROGRESS_ACTIVE_TTL = 1000 * 60 * 5; // 5 minutes for active downloads
const ADD_PROGRESS_DONE_TTL = 1000 * 10; // allow brief polling after completion

function purgeCanceledTokens() {
  const now = Date.now();
  for (const [token, expiry] of canceledAddTokens) {
    if (expiry <= now) canceledAddTokens.delete(token);
  }
}

function markAddCanceled(token) {
  if (!token) return;
  purgeCanceledTokens();
  canceledAddTokens.set(token, Date.now() + CANCELED_TOKEN_TTL);
}

function isAddCanceled(token) {
  if (!token) return false;
  purgeCanceledTokens();
  return canceledAddTokens.has(token);
}

function clearCanceledToken(token) {
  if (!token) return;
  canceledAddTokens.delete(token);
}

function purgeAddProgress() {
  const now = Date.now();
  for (const [token, entry] of addProgressMap) {
    if (!entry || typeof entry.expiresAt !== "number") {
      addProgressMap.delete(token);
      continue;
    }
    if (entry.expiresAt <= now) {
      addProgressMap.delete(token);
    }
  }
}

function setAddProgress(token, value, { done = false } = {}) {
  if (!token) return;
  purgeAddProgress();
  const raw = Number(value);
  const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  const prev = addProgressMap.get(token);
  const nextValue = !done && prev && typeof prev.value === "number"
    ? Math.max(prev.value, clamped)
    : clamped;
  addProgressMap.set(token, {
    value: nextValue,
    done: Boolean(done),
    expiresAt: Date.now() + (done ? ADD_PROGRESS_DONE_TTL : ADD_PROGRESS_ACTIVE_TTL),
  });
}

function markAddProgressDone(token, value = 100) {
  if (!token) return;
  setAddProgress(token, value, { done: true });
}

function readAddProgress(token) {
  if (!token) return null;
  purgeAddProgress();
  const entry = addProgressMap.get(token);
  if (!entry) return null;
  return { value: entry.value, done: entry.done };
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch {}
}

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
const ZIP = await (async () => {
  const candidate = process.env.ZIP_PATH || "zip";
  const det = await detectCommand(candidate);
  if (!det.ok) return { bin: null };
  return { bin: candidate };
})();

function requireBinsOrThrow() {
  if (!FF.bin) throw new Error("ffmpeg not found. Set FFMPEG_PATH env var to its full path.");
  if (!YD.bin) throw new Error("yt-dlp not found. Install it or set YTDLP_PATH env var.");
}

function runYtDlp(args, opts = {}) {
  if (YD.mode === "python") return spawn(YD.bin, ["-m", "yt_dlp", ...args], opts);
  return spawn(YD.bin, args, opts);
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

function normalizeForZip(title) {
  const base = String(title || "")
    .replace(/[\u0000-\u001f]+/g, "")
    .replace(/[\\/:*?"<>|=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return base.slice(0, 180).replace(/[. ]+$/g, "");
}

function formatZipEntryName(title, index, total, ext) {
  const digits = String(Math.max(total, 1)).length;
  const prefix = String(index).padStart(digits, "0");
  const cleanTitle = normalizeForZip(title) || `Track ${index}`;
  const cleanExt = ext && ext.startsWith(".") ? ext : ext ? `.${ext}` : "";
  return `${prefix} ${cleanTitle}${cleanExt}`;
}

function updateProgressFromYtDlp(token, chunk) {
  if (!token || !chunk) return;
  const text = chunk.toString();
  const matches = text.match(/\[download\]\s+([\d.]+)%/g);
  if (matches && matches.length) {
    const last = matches[matches.length - 1];
    const pctMatch = last.match(/([\d.]+)%/);
    if (pctMatch) {
      const pct = parseFloat(pctMatch[1]);
      if (!Number.isNaN(pct)) {
        setAddProgress(token, Math.min(99, pct));
      }
    }
  }
  if (/\[(?:ExtractAudio|Merger|ffmpeg)\]/i.test(text)) {
    setAddProgress(token, 99);
  }
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
  const outTmpl = path.join(config.tmpDir, "%(title)s-%(id)s.%(ext)s");
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
  const out = path.join(config.tmpDir, `${id}.mp3`);
  const args = ["-y", "-i", inputPath, "-vn", "-c:a", "libmp3lame", "-q:a", "0", out];
  const { code, stderr } = await run(FF.bin, args);
  if (code !== 0 || !fs.existsSync(out)) throw new Error(`ffmpeg mp3 failed: ${stderr}`);
  return out;
}

async function transcodeToWav4416(inputPath) {
  const id = nanoid(8);
  const out = path.join(config.tmpDir, `${id}.wav`);
  const args = ["-y", "-i", inputPath, "-vn", "-ar", "44100", "-ac", "2", "-sample_fmt", "s16", out];
  const { code, stderr } = await run(FF.bin, args);
  if (code !== 0 || !fs.existsSync(out)) throw new Error(`ffmpeg wav failed: ${stderr}`);
  return out;
}

function encodeContentDisposition(name) {
  const raw = (name ?? "download").toString();
  const fallback = raw
    .replace(/["\\\r\n;%]+/g, "_")
    .replace(/[^\x20-\x7E]+/g, "_")
    .trim() || "download";
  const encoded = encodeURIComponent(raw);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function streamAndUnlink(res, filePath, downloadName, mimeOverride) {
  const ext = path.extname(filePath).toLowerCase();
  let mime = mimeOverride;
  if (!mime) {
    if (ext === ".mp3") mime = "audio/mpeg";
    else if (ext === ".wav") mime = "audio/wav";
    else if (ext === ".zip") mime = "application/zip";
    else mime = "application/octet-stream";
  }
  const rs = fs.createReadStream(filePath);
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", encodeContentDisposition(downloadName));
  rs.pipe(res);
  rs.on("close", async () => {
    try { await fsp.unlink(filePath); } catch {}
  });
}

// --------------------------- Routes ------------------------------
app.get("/api/diag", async (_req, res) => {
  res.json({ ffmpeg: FF, ytdlp: YD, zip: ZIP });
});

app.get("/api/list", (_req, res) => {
  res.json(playlistStore.toJSON());
});

app.post("/api/clear", async (_req, res) => {
  const cleared = playlistStore.clear();
  await Promise.allSettled(cleared.map((t) => safeUnlink(t.filepath)));
  res.json({ ok: true, totalSeconds: playlistStore.totalSeconds });
});

app.post("/api/remove/:id", async (req, res) => {
  const removed = playlistStore.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: "not found" });
  await safeUnlink(removed.filepath);
  res.json({
    ok: true,
    totalSeconds: playlistStore.totalSeconds,
    capSeconds: playlistStore.capSeconds,
  });
});

app.post("/api/reorder", (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: "Missing order" });
  }

  const ok = playlistStore.reorder(order);
  if (!ok) {
    return res.status(400).json({ error: "Order mismatch" });
  }

  res.json({ ok: true, totalSeconds: playlistStore.totalSeconds, capSeconds: playlistStore.capSeconds });
});

app.get("/api/file/:id", (req, res) => {
  const item = playlistStore.find(req.params.id);
  if (!item) return res.status(404).end();
  res.download(item.filepath, path.basename(item.filepath));
});

app.get("/api/zip", async (_req, res) => {
  if (!playlistStore.items.length) {
    return res.status(400).json({ error: "Playlist is empty" });
  }
  if (!ZIP.bin) {
    return res.status(500).json({ error: "ZIP utility not available" });
  }

  const entries = playlistStore.items
    .map((item, idx) => {
      if (!item?.filepath) return null;
      if (!fs.existsSync(item.filepath)) return null;
      const ext = path.extname(item.filepath) || ".mp3";
      const archiveName = formatZipEntryName(item.title, idx + 1, playlistStore.items.length, ext);
      return { archiveName, filePath: item.filepath };
    })
    .filter(Boolean);

  if (!entries.length) {
    return res.status(400).json({ error: "No files available to zip" });
  }

  const stagingDir = await fsp.mkdtemp(path.join(config.tmpDir, "zip-stage-"));
  const stagedFiles = [];

  try {
    for (const entry of entries) {
      const stagedPath = path.join(stagingDir, entry.archiveName);
      try {
        await fsp.link(entry.filePath, stagedPath);
      } catch (err) {
        if (err?.code === "EXDEV" || err?.code === "EEXIST") {
          await fsp.copyFile(entry.filePath, stagedPath);
        } else {
          throw err;
        }
      }
      stagedFiles.push(stagedPath);
    }

    const zipPath = path.join(config.tmpDir, `cd-${nanoid(10)}.zip`);
    const args = ["-j", "-q", zipPath, ...stagedFiles];
    const { code, stderr } = await run(ZIP.bin, args);
    if (code !== 0 || !fs.existsSync(zipPath)) {
      throw new Error(stderr || `zip exited with code ${code}`);
    }

    const downloadName = `${safeBase("cd-playlist")}.zip`;
    streamAndUnlink(res, zipPath, downloadName, "application/zip");
  } catch (err) {
    console.error("[zip] error:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: "ZIP failed", message: String(err?.message || err) });
    } else {
      res.end();
    }
  } finally {
    await Promise.allSettled(stagedFiles.map((file) => safeUnlink(file)));
    try {
      await fsp.rm(stagingDir, { recursive: true, force: true });
    } catch {}
  }
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

app.post("/api/cancel-add", (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Missing token" });
  }
  markAddCanceled(token);
  res.status(204).end();
});

app.get("/api/add-progress/:token", (req, res) => {
  const token = req.params.token;
  if (!token) {
    return res.json({ progress: null, done: true });
  }
  const entry = readAddProgress(token);
  if (!entry) {
    return res.json({ progress: null, done: false });
  }
  res.json({ progress: entry.value, done: entry.done });
});

// Add to the CD list (stores MP3 file to /downloads and updates the playlist)
app.post("/api/add", async (req, res) => {
  const { url, quality, format_id, client_token, used_client } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid URL" });

  const metaR = await getVideoMetaSmart(url);
  if (!metaR.ok || !metaR.meta?.duration) {
    return res.status(400).json({ error: "Failed to read video metadata", detail: metaR.error, stderr: metaR.stderr });
  }

  if (client_token) {
    setAddProgress(client_token, 0);
  }

  if (client_token && isAddCanceled(client_token)) {
    clearCanceledToken(client_token);
    markAddProgressDone(client_token, 0);
    return res.json({ canceled: true, client_token });
  }

  let filePath = null;

  try {
    const q = (quality || "").toLowerCase();
    const audioQuality = (q === "320" || q === "320k") ? "320K" : "0"; // default V0
    const args = [];

    const clientArg = used_client || metaR.usedClient || "";
    if (clientArg && clientArg.trim()) args.push("--extractor-args", clientArg);
    if (COOKIES_PATH) args.push("--cookies", COOKIES_PATH);
    if (YTDLP_EXTRA) args.push(...YTDLP_EXTRA.split(" ").filter(Boolean));

    const looksLikePath =
      FF.bin && (FF.bin.startsWith("/") || FF.bin.includes("\\") || /^[A-Za-z]:\\/.test(FF.bin));
    if (looksLikePath) args.push("--ffmpeg-location", FF.bin);

    if (format_id) args.push("-f", String(format_id));

    args.push(
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      audioQuality,
      "--no-playlist",
      "--restrict-filenames",
      "-o",
      path.join(config.downloadDir, "%(title)s-%(id)s.%(ext)s"),
      "--print",
      "after_move:filepath",
      "--newline",
      url
    );

    const proc = runYtDlp(args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (client_token) updateProgressFromYtDlp(client_token, text);
    });

    const code = await new Promise((resolve) => {
      proc.on("error", (err) => {
        stderr += `\n${err?.message || err}`;
        resolve(-1);
      });
      proc.on("close", (exitCode) => {
        resolve(exitCode);
      });
    });

    if (client_token) {
      if (code === 0) {
        markAddProgressDone(client_token);
      } else {
        markAddProgressDone(client_token, 0);
      }
    }

    if (code !== 0) throw new Error(`yt-dlp exit ${code}: ${stderr}`);

    filePath = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (!filePath) {
      throw new Error("Failed to determine output file path");
    }
    const stat = await fsp.stat(filePath);

    if (client_token && isAddCanceled(client_token)) {
      clearCanceledToken(client_token);
      markAddProgressDone(client_token, 0);
      await safeUnlink(filePath);
      return res.json({ canceled: true, client_token });
    }

    const item = {
      id: nanoid(8),
      title: metaR.meta.title || path.basename(filePath),
      duration: Number(metaR.meta.duration) || 0,
      filepath: filePath,
      sizeBytes: stat.size,
      videoId: metaR.meta.id || null,
      thumbnail: pickThumbnail(metaR.meta) || null,
    };
    playlistStore.add(item);
    clearCanceledToken(client_token);
    res.json({
      item: {
        id: item.id,
        title: item.title,
        duration: item.duration,
        sizeBytes: item.sizeBytes,
        videoId: item.videoId,
        thumbnail: item.thumbnail,
      },
      totalSeconds: playlistStore.totalSeconds,
      capSeconds: playlistStore.capSeconds,
      client_token,
    });
  } catch (e) {
    clearCanceledToken(client_token);
    if (client_token) {
      markAddProgressDone(client_token, 0);
    }
    if (filePath) await safeUnlink(filePath);
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
// --- Thumbnail proxy: /thumb/:id -> tries WEBP/JPG fallbacks and streams back ---
app.get("/thumb/:id", async (req, res) => {
  try {
    const raw = String(req.params.id || "");
    const id  = raw.match(/^[A-Za-z0-9_-]{6,}$/) ? raw : null;
    if (!id) return res.status(400).send("Bad id");

    const tries = [
      `https://i.ytimg.com/vi_webp/${id}/hqdefault.webp`,
      `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      `https://i.ytimg.com/vi/${id}/0.jpg`,
    ];

    for (const url of tries) {
      const r = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
          "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Referer": "https://www.youtube.com/",
        },
      });
      if (!r.ok) continue;

      const ct = r.headers.get("content-type") || "image/jpeg";
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");

      // Stream or buffer depending on runtime
      if (r.body && typeof r.body.getReader === "function") {
        // Web stream → buffer
        const buf = Buffer.from(await r.arrayBuffer());
        res.end(buf);
      } else if (r.body && typeof r.body.pipe === "function") {
        // Node stream
        r.body.pipe(res);
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        res.end(buf);
      }
      return;
    }

    res.status(404).send("thumb not found");
  } catch (e) {
    res.status(500).send("thumb proxy error");
  }
});


app.listen(config.port, () => {
  console.log(`▶ Listening on http://localhost:${config.port}`);
  console.log(`FFmpeg: ${FF.bin || "NOT FOUND"}`);
  console.log(`yt-dlp: ${YD.bin || "NOT FOUND"} ${YD.mode ? `(mode: ${YD.mode})` : ""}`);
  console.log(`zip: ${ZIP.bin || "NOT FOUND"}`);
});

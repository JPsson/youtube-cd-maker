// server.js — backend for probe, Add To CD, and one-off MP3/WAV download
// Node 18+/20+/22, package.json has "type":"module"

import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// --------------------------- App setup ---------------------------
const config = {
  port: Number(process.env.PORT) || 3000,
  capSeconds: 80 * 60,
  downloadDir: path.join(__dirname, "downloads"),
  tmpDir: path.join(__dirname, "tmp"),
  sessionIdleTtlMs: Number(process.env.SESSION_IDLE_TTL_MS) || 1000 * 60 * 60 * 6, // 6 hours
  downloadTokenTtlMs: Number(process.env.DOWNLOAD_TOKEN_TTL_MS) || 1000 * 60 * 30, // 30 minutes
  cookieSecure: process.env.COOKIE_SECURE === "true",
};

await fsp.mkdir(config.downloadDir, { recursive: true });
await fsp.mkdir(config.tmpDir, { recursive: true });

const SESSION_COOKIE_NAME = "cd_sid";
const SESSION_COOKIE_MAX_AGE = Math.max(60_000, config.sessionIdleTtlMs);
const DOWNLOAD_TOKEN_TTL = Math.max(60_000, config.downloadTokenTtlMs);

const sessionContexts = new Map(); // sid -> context
const sessionCreationPromises = new Map(); // sid -> promise
const downloadTokenIndex = new Map(); // token -> { sessionId, path, filename, expiresAt }

function parseCookies(header) {
  const out = Object.create(null);
  if (!header || typeof header !== "string") return out;
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith("\"")) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // ignore decode errors
    }
    out[key] = value;
  }
  return out;
}

function setCookie(res, value) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", value);
  } else if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, value]);
  } else {
    res.setHeader("Set-Cookie", [prev, value]);
  }
}

function buildSessionCookie(id) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${id}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_COOKIE_MAX_AGE / 1000)}`,
  ];
  if (config.cookieSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function sanitizeSessionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{10,}$/u.test(id) ? id : null;
}

function sessionFsKey(id) {
  return createHash("sha256").update(String(id)).digest("hex").slice(0, 32);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function createSessionContext(sessionId) {
  const key = sessionFsKey(sessionId);
  const sessionTmpRoot = path.join(config.tmpDir, `session-${key}`);
  const trackDir = path.join(sessionTmpRoot, "tracks");
  const scratchDir = path.join(sessionTmpRoot, "scratch");
  const downloadsDir = path.join(config.downloadDir, `session-${key}`);

  await Promise.all([
    ensureDir(sessionTmpRoot),
    ensureDir(trackDir),
    ensureDir(scratchDir),
    ensureDir(downloadsDir),
  ]);

  const ctx = {
    id: sessionId,
    key,
    playlist: new PlaylistStore(config.capSeconds),
    trackDir,
    scratchDir,
    downloadsDir,
    downloadTokens: new Set(),
    lastAccess: Date.now(),
  };

  console.log("[session] context created", {
    sessionId,
    trackDir,
    scratchDir,
    downloadsDir,
  });

  return ctx;
}

async function getSessionContext(req) {
  const sid = req.sessionId;
  if (!sid) throw new Error("Session ID missing");
  const existing = sessionContexts.get(sid);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing;
  }

  let pending = sessionCreationPromises.get(sid);
  if (!pending) {
    pending = (async () => {
      const ctx = await createSessionContext(sid);
      sessionContexts.set(sid, ctx);
      sessionCreationPromises.delete(sid);
      return ctx;
    })();
    sessionCreationPromises.set(sid, pending);
  }

  const ctx = await pending;
  ctx.lastAccess = Date.now();
  return ctx;
}

async function destroySessionContext(sessionId) {
  const ctx = sessionContexts.get(sessionId);
  if (!ctx) return;
  sessionContexts.delete(sessionId);
  sessionCreationPromises.delete(sessionId);

  console.log("[session] destroying context", { sessionId, key: ctx.key });

  for (const token of ctx.downloadTokens) {
    dropDownloadToken(token, downloadTokenIndex.get(token));
  }
  ctx.downloadTokens.clear();

  const cleared = ctx.playlist.clear();
  await Promise.allSettled(cleared.map((item) => safeUnlink(item?.filepath)));

  const dirs = [ctx.trackDir, ctx.scratchDir, ctx.downloadsDir, path.join(config.tmpDir, `session-${ctx.key}`)];
  await Promise.allSettled(dirs.map(async (dir) => {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {}
  }));
}

function purgeDownloadTokens() {
  const now = Date.now();
  for (const [token, entry] of downloadTokenIndex) {
    if (!entry || entry.expiresAt <= now) {
      console.log("[downloads] expiring token", token);
      dropDownloadToken(token, entry);
    }
  }
}

async function purgeStaleSessions() {
  const now = Date.now();
  const sweeps = [];
  for (const [sid, ctx] of sessionContexts) {
    if (!ctx || ctx.lastAccess + SESSION_COOKIE_MAX_AGE <= now) {
      console.log("[session] sweeping idle session", sid);
      sweeps.push(destroySessionContext(sid));
    }
  }
  if (sweeps.length) {
    await Promise.allSettled(sweeps);
  }
}

setInterval(() => {
  purgeDownloadTokens();
  purgeStaleSessions().catch((err) => {
    console.warn("[session] sweep failed:", err?.message || err);
  });
}, Math.min(SESSION_COOKIE_MAX_AGE, 1000 * 60 * 10)).unref?.();

function sessionCookieMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers?.cookie);
  const cookieSid = sanitizeSessionId(cookies[SESSION_COOKIE_NAME]);
  const rawHeaderHint = req.headers?.["x-cd-session"];
  const headerHint = sanitizeSessionId(Array.isArray(rawHeaderHint) ? rawHeaderHint[0] : rawHeaderHint);

  const requestInfo = { method: req.method, url: req.originalUrl || req.url };

  const headerKnown =
    headerHint && (sessionContexts.has(headerHint) || sessionCreationPromises.has(headerHint));

  let sid = cookieSid;

  if (headerHint && (!sid || sid !== headerHint)) {
    if (headerKnown) {
      sid = headerHint;
      console.log("[session] restored from hint", { sessionId: sid, ...requestInfo });
    } else if (!sid) {
      sid = headerHint;
      console.log("[session] adopting hinted id", { sessionId: sid, ...requestInfo });
    }
  }

  if (!sid) {
    sid = nanoid(24);
    console.log("[session] issued new session id", sid, requestInfo);
  }

  req.sessionId = sid;
  try {
    setCookie(res, buildSessionCookie(sid));
  } catch (err) {
    console.warn("[session] failed to set cookie:", err?.message || err);
  }

  try {
    res.setHeader("X-CD-Session", sid);
  } catch (err) {
    console.warn("[session] failed to set session header:", err?.message || err);
  }

  next();
}

const ENV_COOKIES_PATH = process.env.COOKIES_PATH || null;
const ENV_COOKIES_TEXT = process.env.COOKIES_TEXT || null;
const ENV_COOKIES_BASE64 = process.env.COOKIES_BASE64 || null;
const DEFAULT_COOKIES_FILENAME = "cookies.txt";

async function materializeCookiesFromEnv() {
  if (ENV_COOKIES_PATH) return ENV_COOKIES_PATH;

  let rawText = ENV_COOKIES_TEXT;
  if (ENV_COOKIES_BASE64) {
    try {
      rawText = Buffer.from(ENV_COOKIES_BASE64, "base64").toString("utf8");
    } catch (err) {
      console.warn("[cookies] Failed to decode COOKIES_BASE64:", err?.message || err);
      return null;
    }
  }

  if (!rawText || !rawText.trim()) return null;

  const target = path.join(config.tmpDir, "cookies-env.txt");
  await fsp.writeFile(target, rawText, "utf8");
  return target;
}

async function detectCookiesFile() {
  const fromEnv = await materializeCookiesFromEnv();
  if (fromEnv) {
    return {
      path: fromEnv,
      source: ENV_COOKIES_PATH ? "path" : "env",
    };
  }

  const defaultPath = path.join(__dirname, DEFAULT_COOKIES_FILENAME);
  try {
    const stat = await fsp.stat(defaultPath);
    if (stat.isFile()) {
      return {
        path: defaultPath,
        source: "file",
      };
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.warn("[cookies] Failed to access default cookies file:", err?.message || err);
    }
  }

  return { path: null, source: null };
}

const COOKIES_INFO = await detectCookiesFile();
if (COOKIES_INFO.path) {
  console.log(`[cookies] Using ${COOKIES_INFO.source} cookies file at ${COOKIES_INFO.path}`);
}

const app = express();

app.use(sessionCookieMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function serveDownload(req, res, { head = false } = {}) {
  purgeDownloadTokens();

  const token = req.params.token || "";
  if (!token || typeof token !== "string") {
    return res.status(404).json({ error: "Download expired" });
  }

  const entry = downloadTokenIndex.get(token);
  if (!entry) {
    return res.status(404).json({ error: "Download expired" });
  }

  console.log("[downloads] %s request", head ? "HEAD" : "GET", {
    token,
    sessionId: entry.sessionId,
    filename: entry.filename,
  });

  if (!req.sessionId || req.sessionId !== entry.sessionId) {
    req.sessionId = entry.sessionId;
    try {
      setCookie(res, buildSessionCookie(entry.sessionId));
    } catch (err) {
      console.warn("[downloads] failed to rebind session cookie:", err?.message || err);
    }
  }

  try {
    res.setHeader("X-CD-Session", entry.sessionId);
  } catch (err) {
    console.warn("[downloads] failed to set session header:", err?.message || err);
  }

  let stat;
  try {
    stat = await fsp.stat(entry.path);
  } catch (err) {
    dropDownloadToken(token, entry);
    if (err?.code === "ENOENT") {
      return res.status(404).json({ error: "File not found" });
    }
    console.error("[downloads] stat failed:", err?.message || err);
    return res.status(500).json({ error: "Failed to read download" });
  }

  if (!stat.isFile()) {
    dropDownloadToken(token, entry);
    return res.status(404).json({ error: "File not found" });
  }

  entry.expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL;
  const ctx = sessionContexts.get(entry.sessionId);
  if (ctx) ctx.lastAccess = Date.now();

  if (head) {
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${entry.filename}"`);
    console.log("[downloads] responded to HEAD", { token, size: stat.size });
    return res.status(200).end();
  }

  return res.download(entry.path, entry.filename, (err) => {
    if (!err) {
      console.log("[downloads] completed transfer", { token, filename: entry.filename });
      dropDownloadToken(token, entry);
      return;
    }
    if (err?.code === "ENOENT") {
      dropDownloadToken(token, entry);
      if (!res.headersSent) res.status(404).json({ error: "File not found" });
      return;
    }
    console.error("[downloads] send failed:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to send download" });
    }
  });
}

app.get("/downloads/:token", (req, res) => serveDownload(req, res));
app.head("/downloads/:token", (req, res) => serveDownload(req, res, { head: true }));

function registerDownloadToken(ctx, filePath, filename) {
  if (!ctx) throw new Error("Session context missing");
  const token = nanoid(21);
  downloadTokenIndex.set(token, {
    sessionId: ctx.id,
    path: filePath,
    filename,
    expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL,
  });
  ctx.downloadTokens.add(token);
  ctx.lastAccess = Date.now();
  console.log("[downloads] token issued", { token, sessionId: ctx.id, filename });
  return token;
}

function dropDownloadToken(token, entry) {
  downloadTokenIndex.delete(token);
  if (!entry) return;
  const ctx = entry.sessionId ? sessionContexts.get(entry.sessionId) : null;
  ctx?.downloadTokens.delete(token);
  console.log("[downloads] token dropped", { token, sessionId: entry?.sessionId, filename: entry?.filename });
}

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
  const prevLogged = prev?.loggedValue ?? prev?.value ?? null;
  if (prevLogged === null || done !== prev?.done || Math.abs(nextValue - prevLogged) >= 5) {
    console.log("[add] progress", { token, value: nextValue, done });
  }
  addProgressMap.set(token, {
    value: nextValue,
    done: Boolean(done),
    expiresAt: Date.now() + (done ? ADD_PROGRESS_DONE_TTL : ADD_PROGRESS_ACTIVE_TTL),
    loggedValue: nextValue,
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

const COOKIES_PATH  = COOKIES_INFO.path;
const COOKIES_SOURCE = COOKIES_INFO.source;
// You may force a client via env, e.g. YTDLP_EXTRACTOR_ARGS="youtube:player_client=web"
const EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS ?? "youtube:player_client=tv";
const YTDLP_EXTRA    = process.env.YTDLP_EXTRA || "--force-ipv4"; // helps on some networks

function splitArgs(str) {
  if (!str) return [];
  const re = /(?:[^\s"]+|"[^"]*")+/g;
  const out = [];
  for (const m of str.match(re) || []) {
    out.push(m.replace(/^"|"$/g, ""));
  }
  return out;
}


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
  if (YTDLP_EXTRA) args.push(...splitArgs(YTDLP_EXTRA));
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

  const clients = [
    "youtube:player_client=tv",
    "youtube:player_client=tv_embedded",
    "youtube:player_client=web",
    "youtube:player_client=ios",
    "youtube:player_client=android",
    "",
  ];
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
async function downloadSourceToTmp(url, formatId, clientArg /* pass-through */, baseDir = config.tmpDir) {
  requireBinsOrThrow();
  await ensureDir(baseDir);
  const outTmpl = path.join(baseDir, `${nanoid(6)}-%(title)s-%(id)s.%(ext)s`);
  const args = [];
  if (formatId) args.push("-f", String(formatId));
  const looksLikePath =
    FF.bin && (FF.bin.startsWith("/") || FF.bin.includes("\\") || /^[A-Za-z]:\\/.test(FF.bin));
  if (looksLikePath) args.push("--ffmpeg-location", FF.bin);
  if (COOKIES_PATH) args.push("--cookies", COOKIES_PATH);
  if (clientArg && clientArg.trim()) args.push("--extractor-args", clientArg);
  if (YTDLP_EXTRA) args.push(...splitArgs(YTDLP_EXTRA));
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

async function transcodeToMp3V0(inputPath, baseDir = config.tmpDir) {
  const id = nanoid(8);
  await ensureDir(baseDir);
  const out = path.join(baseDir, `${id}.mp3`);
  const args = ["-y", "-i", inputPath, "-vn", "-c:a", "libmp3lame", "-q:a", "0", out];
  const { code, stderr } = await run(FF.bin, args);
  if (code !== 0 || !fs.existsSync(out)) throw new Error(`ffmpeg mp3 failed: ${stderr}`);
  return out;
}

async function transcodeToWav4416(inputPath, baseDir = config.tmpDir) {
  const id = nanoid(8);
  await ensureDir(baseDir);
  const out = path.join(baseDir, `${id}.wav`);
  const args = ["-y", "-i", inputPath, "-vn", "-ar", "44100", "-ac", "2", "-sample_fmt", "s16", out];
  const { code, stderr } = await run(FF.bin, args);
  if (code !== 0 || !fs.existsSync(out)) throw new Error(`ffmpeg wav failed: ${stderr}`);
  return out;
}

async function moveIntoDownloads(tmpPath, desiredName, targetDir = config.downloadDir) {
  const ext = path.extname(desiredName);
  const stem = path.basename(desiredName, ext) || "download";
  const safeStem = safeBase(stem);
  const safeExt = ext && ext.startsWith(".") ? ext : ext ? `.${ext}` : "";

  await ensureDir(targetDir);

  for (let attempt = 0; attempt < 1000; attempt++) {
    const suffix = attempt === 0 ? "" : ` (${attempt})`;
    const filename = `${safeStem}${suffix}${safeExt}`;
    const destPath = path.join(targetDir, filename);

    try {
      await fsp.access(destPath);
      continue; // file exists, try next suffix
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }

    try {
      await fsp.rename(tmpPath, destPath);
      return { path: destPath, filename };
    } catch (err) {
      if (err?.code === "EEXIST") {
        continue;
      }
      if (err?.code === "EXDEV") {
        await fsp.copyFile(tmpPath, destPath);
        await fsp.unlink(tmpPath);
        return { path: destPath, filename };
      }
      throw err;
    }
  }

  throw new Error("Failed to allocate download filename");
}

// --------------------------- Routes ------------------------------
app.get("/api/diag", async (_req, res) => {
  res.json({
    ffmpeg: FF,
    ytdlp: YD,
    zip: ZIP,
    cookies: {
      path: COOKIES_PATH,
      source: COOKIES_SOURCE,
    },
  });
});

app.get("/api/list", async (req, res) => {
  try {
    const ctx = await getSessionContext(req);
    console.log("[playlist] list", { sessionId: ctx.id, count: ctx.playlist.items.length });
    res.json(ctx.playlist.toJSON());
  } catch (err) {
    console.error("[list] session error:", err?.message || err);
    res.status(500).json({ error: "Session error" });
  }
});

app.post("/api/clear", async (req, res) => {
  try {
    const ctx = await getSessionContext(req);
    const cleared = ctx.playlist.clear();
    await Promise.allSettled(cleared.map((t) => safeUnlink(t?.filepath)));
    console.log("[playlist] cleared", { sessionId: ctx.id, removed: cleared.length });
    res.json({ ok: true, totalSeconds: ctx.playlist.totalSeconds });
  } catch (err) {
    console.error("[clear] session error:", err?.message || err);
    res.status(500).json({ error: "Session error" });
  }
});

app.post("/api/remove/:id", async (req, res) => {
  try {
    const ctx = await getSessionContext(req);
    const removed = ctx.playlist.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: "not found" });
    await safeUnlink(removed.filepath);
    console.log("[playlist] removed", { sessionId: ctx.id, itemId: removed.id, title: removed.title });
    res.json({
      ok: true,
      totalSeconds: ctx.playlist.totalSeconds,
      capSeconds: ctx.playlist.capSeconds,
    });
  } catch (err) {
    console.error("[remove] session error:", err?.message || err);
    res.status(500).json({ error: "Session error" });
  }
});

app.post("/api/reorder", async (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: "Missing order" });
  }

  try {
    const ctx = await getSessionContext(req);
    const ok = ctx.playlist.reorder(order);
    if (!ok) {
      return res.status(400).json({ error: "Order mismatch" });
    }

    console.log("[playlist] reordered", { sessionId: ctx.id, order });
    res.json({ ok: true, totalSeconds: ctx.playlist.totalSeconds, capSeconds: ctx.playlist.capSeconds });
  } catch (err) {
    console.error("[reorder] session error:", err?.message || err);
    res.status(500).json({ error: "Session error" });
  }
});

app.get("/api/file/:id", async (req, res) => {
  try {
    const ctx = await getSessionContext(req);
    const item = ctx.playlist.find(req.params.id);
    if (!item) return res.status(404).end();
    console.log("[playlist] file download", { sessionId: ctx.id, itemId: item.id, title: item.title });
    res.download(item.filepath, path.basename(item.filepath));
  } catch (err) {
    console.error("[file] session error:", err?.message || err);
    res.status(500).end();
  }
});

app.post("/api/zip", async (req, res) => {
  let ctx;
  try {
    ctx = await getSessionContext(req);
  } catch (err) {
    console.error("[zip] session error:", err?.message || err);
    return res.status(500).json({ error: "Session error" });
  }

  const playlistStore = ctx.playlist;

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

  console.log("[zip] preparing", { sessionId: ctx.id, entries: entries.length });
  await ensureDir(ctx.scratchDir);
  const stagingDir = await fsp.mkdtemp(path.join(ctx.scratchDir, "zip-stage-"));
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

    let zipPath = path.join(ctx.scratchDir, `cd-${nanoid(10)}.zip`);
    const args = ["-j", "-q", zipPath, ...stagedFiles];
    const { code, stderr } = await run(ZIP.bin, args);
    if (code !== 0 || !fs.existsSync(zipPath)) {
      throw new Error(stderr || `zip exited with code ${code}`);
    }

    let finalInfo = null;
    try {
      const downloadName = `${safeBase("cd-playlist")}.zip`;
      finalInfo = await moveIntoDownloads(zipPath, downloadName, ctx.downloadsDir);
      zipPath = null;
    } catch (err) {
      if (zipPath) await safeUnlink(zipPath);
      throw err;
    }

    const stat = await fsp.stat(finalInfo.path).catch(() => null);
    const token = registerDownloadToken(ctx, finalInfo.path, finalInfo.filename);

    console.log("[zip] ready", {
      sessionId: ctx.id,
      filename: finalInfo.filename,
      sizeBytes: stat?.size ?? null,
      token,
    });

    res.json({
      ok: true,
      href: `/downloads/${encodeURIComponent(token)}`,
      filename: finalInfo.filename,
      sizeBytes: stat?.size ?? null,
    });
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
  let { url, fast } = req.body || {};
  url = canonicalizeYouTube(url);
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid URL" });
  console.log("[probe] requested", { url, fast: Boolean(fast) });
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
  console.log("[add] cancel requested", { token });
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


function canonicalizeYouTube(u) {
  try {
    const url = new URL(u);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1);
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    if (url.hostname.endsWith("youtube.com")) {
      const id = url.searchParams.get("v");
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
  } catch {}
  return u;
}
// Add to the CD list (stores MP3 file to /downloads and updates the playlist)
app.post("/api/add", async (req, res) => {
  let { url, quality, format_id, client_token, used_client } = req.body || {};
  url = canonicalizeYouTube(url);
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid URL" });

  let ctx;
  try {
    ctx = await getSessionContext(req);
  } catch (err) {
    console.error("[add] session error:", err?.message || err);
    return res.status(500).json({ error: "Session error" });
  }
  const playlistStore = ctx.playlist;

  console.log("[add] requested", {
    sessionId: ctx.id,
    url,
    quality: quality || null,
    formatId: format_id || null,
    clientToken: client_token || null,
  });

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

    const clientArg = metaR.usedClient || used_client || "";
    if (clientArg && clientArg.trim()) args.push("--extractor-args", clientArg);
    if (COOKIES_PATH) args.push("--cookies", COOKIES_PATH);
    if (YTDLP_EXTRA) args.push(...splitArgs(YTDLP_EXTRA));

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
      path.join(ctx.trackDir, "%(title)s-%(id)s.%(ext)s"),
      "--print",
      "after_move:filepath",
      "--newline",
      url
    );

    const proc = runYtDlp(args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (client_token) updateProgressFromYtDlp(client_token, text);
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
    ctx.lastAccess = Date.now();
    clearCanceledToken(client_token);
    console.log("[add] completed", {
      sessionId: ctx.id,
      itemId: item.id,
      title: item.title,
      duration: item.duration,
      sizeBytes: item.sizeBytes,
    });
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

// One-off conversion endpoint (MP3 or WAV) that prepares a download link
app.post("/api/convert", async (req, res) => {
  const { url, target, format_id, used_client } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid URL" });
  const tgt = String(target || "").toLowerCase();
  if (!["mp3", "wav"].includes(tgt)) return res.status(400).json({ error: "Invalid target (mp3|wav)" });

  let ctx;
  try {
    ctx = await getSessionContext(req);
  } catch (err) {
    console.error("[convert] session error:", err?.message || err);
    return res.status(500).json({ error: "Session error" });
  }

  console.log("[convert] requested", {
    sessionId: ctx.id,
    url,
    target: tgt,
    formatId: format_id || null,
  });

  let dbgFormats = null, chosenFmt = null, clientArg = null, metaTitle = null;

  try {
    const r = await getVideoMetaSmart(url);
    if (!r.ok) {
      return res.status(400).json({
        error: "Failed to read metadata",
        detail: r.error, code: r.code, stderr: r.stderr
      });
    }
    metaTitle = r.meta?.title || null;
    clientArg = r.usedClient || used_client || "";

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

    const src = await downloadSourceToTmp(url, fmtId, clientArg, ctx.scratchDir);
    console.log("[convert] downloaded source", { sessionId: ctx.id, target: tgt, src });

    let outPath = null;
    try {
      if (tgt === "mp3") {
        outPath = await transcodeToMp3V0(src, ctx.scratchDir);      // VBR V0 (best from lossy source)
      } else {
        outPath = await transcodeToWav4416(src, ctx.scratchDir);    // 44.1kHz/16-bit (CD)
      }
    } finally {
      try { await fsp.unlink(src); } catch {}
    }

    let finalInfo = null;
    try {
      const base = safeBase(metaTitle);
      const downloadName = `${base}.${tgt}`;
      finalInfo = await moveIntoDownloads(outPath, downloadName, ctx.downloadsDir);
      outPath = null;
    } catch (err) {
      if (outPath) await safeUnlink(outPath);
      throw err;
    }

    const stat = await fsp.stat(finalInfo.path).catch(() => null);
    const token = registerDownloadToken(ctx, finalInfo.path, finalInfo.filename);
    console.log("[convert] ready", {
      sessionId: ctx.id,
      filename: finalInfo.filename,
      sizeBytes: stat?.size ?? null,
      token,
    });

    res.json({
      ok: true,
      href: `/downloads/${encodeURIComponent(token)}`,
      filename: finalInfo.filename,
      sizeBytes: stat?.size ?? null,
    });

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

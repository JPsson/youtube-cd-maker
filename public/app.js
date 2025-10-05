const dom = {
  url: document.getElementById("url"),
  btnAdd: document.getElementById("btnAdd"),
  btnMp3: document.getElementById("btnMp3"),
  btnWav: document.getElementById("btnWav"),
  pickedNote: document.getElementById("pickedNote"),
  thumbWrap: document.querySelector(".thumbWrap"),
  thumb: document.getElementById("thumb"),
  thumbSkeleton: document.getElementById("thumbSkeleton"),
  listBody: document.getElementById("listBody"),
  gaugeFill: document.getElementById("gaugeFill"),
  gaugeText: document.getElementById("gaugeText"),
  clearBtn: document.getElementById("clear"),
  downloadZipBtn: document.getElementById("downloadZip"),
  overlayRoot: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlaySubtitle: document.getElementById("overlaySubtitle"),
  overlayDots: document.getElementById("overlayDots"),
  overlayThumbFrame: document.getElementById("overlayThumbFrame"),
  overlayThumb: document.getElementById("overlayThumb"),
  overlayThumbSkeleton: document.getElementById("overlayThumbSkeleton"),
  overlayDisc: document.getElementById("overlayDisc"),
  disclaimerLink: document.getElementById("disclaimerLink"),
  disclaimerOverlay: document.getElementById("disclaimerOverlay"),
  disclaimerClose: document.getElementById("disclaimerClose"),
  themeToggle: document.getElementById("themeToggle"),
};

const state = {
  server: { capSeconds: 80 * 60, totalSeconds: 0, items: [] },
  optimisticAdds: [],
  nextOrderHint: 1,
};

let sessionHint = null;
let refreshRequestId = 0;

const THEME_STORAGE_KEY = "cd-maker-theme";

const pendingAddRequests = new Map();
const optimisticLoadingIndicators = new Map();
let lastDisclaimerTrigger = null;

const probeCache = new Map(); // key -> { fast, smart, pendingFast, pendingSmart, ts }

function orderValueOf(item) {
  if (!item) return Infinity;
  const candidates = [
    item.orderHint,
    item.order,
    item.ordinal,
    item.sequence,
    item.seq,
  ];
  for (const raw of candidates) {
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }
  return Infinity;
}

function registerOrderCursor(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return;
  state.nextOrderHint = Math.max(state.nextOrderHint, Math.floor(num) + 1);
}

function updateOrderCursorFromServerItems(items) {
  if (!Array.isArray(items) || !items.length) {
    state.nextOrderHint = Math.max(state.nextOrderHint, 1);
    return;
  }
  let maxOrder = -Infinity;
  for (const item of items) {
    const val = orderValueOf(item);
    if (Number.isFinite(val) && val > maxOrder) {
      maxOrder = val;
    }
  }
  if (Number.isFinite(maxOrder)) {
    registerOrderCursor(maxOrder);
  } else {
    state.nextOrderHint = Math.max(state.nextOrderHint, items.length + 1);
  }
}

function insertServerItemOrdered(items, item) {
  if (!item) return;
  const targetOrder = orderValueOf(item);
  if (!Number.isFinite(targetOrder)) {
    items.push(item);
    return;
  }
  registerOrderCursor(targetOrder);
  const existingIdx = items.findIndex((entry) => orderValueOf(entry) > targetOrder);
  if (existingIdx === -1) {
    items.push(item);
  } else {
    items.splice(existingIdx, 0, item);
  }
}

const prefersDarkScheme =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
let userPreferredTheme = null;

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") {
      userPreferredTheme = stored;
      return stored;
    }
  } catch (err) {
    // ignore storage errors (e.g. private mode)
  }
  userPreferredTheme = null;
  return prefersDarkScheme?.matches ? "dark" : "light";
}

function applyTheme(mode, { persist = false } = {}) {
  const next = mode === "dark" ? "dark" : "light";
  const root = document.documentElement;
  if (root) {
    root.classList.add("no-theme-transition");
    root.dataset.theme = next;
    const clear = () => root.classList.remove("no-theme-transition");
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(clear));
    } else {
      setTimeout(clear, 0);
    }
  }

  if (dom.themeToggle) {
    dom.themeToggle.setAttribute(
      "aria-label",
      next === "dark" ? "Switch to light mode" : "Switch to dark mode"
    );
    dom.themeToggle.setAttribute("data-theme", next);
    dom.themeToggle.setAttribute(
      "title",
      next === "dark" ? "Switch to light mode" : "Switch to dark mode"
    );
  }

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (err) {
      // ignore storage errors
    }
    userPreferredTheme = next;
  }
}

function initThemeToggle() {
  if (!dom.themeToggle) return;

  const initial = readStoredTheme();
  applyTheme(initial);

  dom.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next, { persist: true });
  });

  const handleSystemChange = (event) => {
    if (userPreferredTheme) return;
    applyTheme(event.matches ? "dark" : "light");
  };

  if (prefersDarkScheme?.addEventListener) {
    prefersDarkScheme.addEventListener("change", handleSystemChange);
  } else if (prefersDarkScheme?.addListener) {
    prefersDarkScheme.addListener(handleSystemChange);
  }
}

class DotsAnimator {
  constructor(target, interval = 400) {
    this.target = target;
    this.interval = interval;
    this.timer = null;
    this.tick = 0;
  }

  start() {
    if (!this.target) return;
    this.stop();
    this.tick = 0;
    this.target.textContent = ".";
    this.timer = setInterval(() => {
      this.tick = (this.tick + 1) % 4;
      this.target.textContent = ".".repeat(this.tick || 1);
    }, this.interval);
  }

  stop() {
    if (!this.target) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tick = 0;
    this.target.textContent = "";
  }
}

class OverlayController {
  constructor({
    root,
    title,
    subtitle,
    thumbFrame,
    thumb,
    thumbSkeleton,
    disc,
  }) {
    this.root = root;
    this.titleEl = title;
    this.subtitleEl = subtitle;
    this.thumbFrameEl = thumbFrame;
    this.thumbEl = thumb;
    this.thumbSkeletonEl = thumbSkeleton;
    this.discEl = disc;
    this.currentThumbHandler = null;
  }

  showConversion({ title, subtitle, thumbSrc }) {
    this.prepareOverlay("convert");
    this.setTitle(title);
    this.setSubtitle(subtitle);
    this.renderDisc([]);
    this.renderThumb(thumbSrc);
  }

  showZip({ title, subtitle, thumbnails }) {
    this.prepareOverlay("zip");
    this.setTitle(title);
    this.setSubtitle(subtitle);
    this.renderThumb(null);
    this.renderDisc(thumbnails);
  }

  prepareOverlay(mode) {
    if (!this.root) return;
    this.root.dataset.mode = mode;
    this.root.hidden = false;
    this.root.setAttribute("aria-hidden", "false");
  }

  setTitle(title) {
    if (!this.titleEl) return;
    this.titleEl.textContent = title || "";
  }

  setSubtitle(subtitle, { allowHtml = false } = {}) {
    if (!this.subtitleEl) return;
    if (allowHtml) {
      this.subtitleEl.innerHTML = subtitle || "";
    } else {
      this.subtitleEl.textContent = subtitle || "";
    }
  }

  hide() {
    if (!this.root) return;
    this.root.hidden = true;
    this.root.setAttribute("aria-hidden", "true");
    this.setTitle("");
    this.setSubtitle("");
    this.renderThumb(null);
    this.renderDisc([]);
  }

  renderThumb(src) {
    if (!this.thumbFrameEl || !this.thumbEl || !this.thumbSkeletonEl) return;

    if (!src) {
      this.thumbEl.removeAttribute("src");
      this.thumbEl.classList.remove("show");
      this.thumbFrameEl.classList.remove("show");
      this.thumbSkeletonEl.hidden = true;
      this.currentThumbHandler = null;
      return;
    }

    const img = this.thumbEl;
    if (this.currentThumbHandler) {
      img.removeEventListener("load", this.currentThumbHandler.load);
      img.removeEventListener("error", this.currentThumbHandler.error);
    }

    this.thumbFrameEl.classList.add("show");
    this.thumbSkeletonEl.hidden = false;
    img.classList.remove("show");

    const onLoad = () => {
      this.thumbSkeletonEl.hidden = true;
      img.classList.add("show");
    };
    const onError = () => {
      this.thumbSkeletonEl.hidden = true;
      this.thumbFrameEl.classList.remove("show");
      img.classList.remove("show");
      img.removeAttribute("src");
    };

    this.currentThumbHandler = { load: onLoad, error: onError };
    img.addEventListener("load", onLoad, { once: true });
    img.addEventListener("error", onError, { once: true });
    img.src = src;
  }

  renderDisc(thumbnails) {
    if (!this.discEl) return;
    this.discEl.innerHTML = "";
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
      this.discEl.classList.remove("show");
      return;
    }

    const unique = Array.from(new Set(thumbnails.filter(Boolean)));
    if (!unique.length) {
      this.discEl.classList.remove("show");
      return;
    }

    this.discEl.classList.add("show");

    const maxItems = 18;
    const items = unique.slice(0, maxItems);
    const total = items.length;
    const outerCount = total > 8 ? Math.ceil(total * 0.6) : total;
    const innerCount = total - outerCount;
    const outerRadius =
      total === 1 ? 0 : total === 2 ? 28 : total <= 5 ? 34 : total <= 10 ? 38 : 42;
    const innerRadius =
      innerCount > 0 ? Math.max(16, Math.round(outerRadius * 0.55)) : 0;
    const baseSize =
      total === 1
        ? 58
        : total <= 3
        ? 44
        : total <= 5
        ? 34
        : total <= 9
        ? 28
        : 22;

    items.forEach((src, idx) => {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";

      const inOuter = idx < outerCount || innerCount <= 0;
      const positionIndex = inOuter ? idx : idx - outerCount;
      const ringCount = inOuter ? outerCount : innerCount || 1;
      const radius = inOuter ? outerRadius : innerRadius;
      const angle = (positionIndex / ringCount) * Math.PI * 2 - Math.PI / 2;
      const x = 50 + Math.cos(angle) * radius;
      const y = 50 + Math.sin(angle) * radius;
      const size = inOuter ? baseSize : Math.max(18, baseSize - 8);
      const tiltBase = inOuter ? 14 : 8;
      const tilt = (positionIndex % 2 === 0 ? -1 : 1) * (tiltBase + (positionIndex % 3) * 3);

      img.style.width = `${size}%`;
      img.style.left = `${x}%`;
      img.style.top = `${y}%`;
      img.style.transform = `translate(-50%, -50%) rotate(${tilt}deg)`;

      this.discEl.appendChild(img);
    });
  }
}

class PlaylistRenderer {
  constructor({ body, gaugeFill, gaugeText }) {
    this.body = body;
    this.gaugeFill = gaugeFill;
    this.gaugeText = gaugeText;
  }

  render(server, optimistic) {
    if (!this.body) return;

    const frag = document.createDocumentFragment();
    const serverItems = Array.isArray(server.items) ? server.items : [];
    const optimisticItems = Array.isArray(optimistic) ? optimistic : [];

    const combined = [];
    serverItems.forEach((item, idx) => {
      combined.push({
        kind: "server",
        item,
        order: orderValueOf(item),
        createdAt: idx,
        tie: idx,
      });
    });

    optimisticItems.forEach((item, idx) => {
      combined.push({
        kind: "optimistic",
        item,
        order: orderValueOf(item),
        createdAt: item?.createdAt || 0,
        tie: serverItems.length + idx,
      });
    });

    combined.sort((a, b) => {
      const ao = Number.isFinite(a.order) ? a.order : Infinity;
      const bo = Number.isFinite(b.order) ? b.order : Infinity;
      if (ao !== bo) return ao - bo;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.tie - b.tie;
    });

    combined.forEach((entry, idx) => {
      if (entry.kind === "server") {
        frag.appendChild(this.createServerRow(entry.item, idx + 1));
      } else {
        frag.appendChild(this.createOptimisticRow(entry.item, idx + 1));
      }
    });

    this.body.replaceChildren(frag);
    this.renderGauge(server, optimisticItems);
  }

  createServerRow(item, index) {
    const tr = document.createElement("tr");
    if (item?.id) {
      tr.dataset.itemId = item.id;
      tr.dataset.draggable = "true";
    } else {
      tr.dataset.draggable = "false";
    }

    const idxTd = document.createElement("td");
    idxTd.className = "colIndex";
    idxTd.textContent = index;
    tr.appendChild(idxTd);

    const titleTd = document.createElement("td");
    titleTd.className = "colTitle";
    titleTd.textContent = item?.title || "Untitled";
    tr.appendChild(titleTd);

    const durTd = document.createElement("td");
    durTd.className = "colDur";
    durTd.textContent = fmtTime(item?.duration || 0);
    tr.appendChild(durTd);

    const actTd = document.createElement("td");
    actTd.className = "colAct";
    const removeBtn = document.createElement("button");
    removeBtn.className = "action danger";
    removeBtn.dataset.remove = item.id;
    removeBtn.textContent = "Remove";
    actTd.appendChild(removeBtn);
    tr.appendChild(actTd);

    return tr;
  }

  createOptimisticRow(item, index) {
    const tr = document.createElement("tr");
    if (item?.token) {
      tr.dataset.optimisticToken = item.token;
    }

    const idxTd = document.createElement("td");
    idxTd.className = "colIndex";
    idxTd.textContent = index;
    tr.appendChild(idxTd);

    const titleTd = document.createElement("td");
    titleTd.className = "colTitle";
    titleTd.textContent = item?.title || "Loading…";
    tr.appendChild(titleTd);

    const durTd = document.createElement("td");
    durTd.className = "colDur";
    durTd.textContent = item?.duration ? fmtTime(item.duration) : "—";
    tr.appendChild(durTd);

    const actTd = document.createElement("td");
    actTd.className = "colAct colAct--optimistic";
    const status = document.createElement("span");
    status.className = "optimisticProgress";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-busy", "true");
    if (item?.token) {
      status.dataset.optimisticToken = item.token;
    }
    status.setAttribute("aria-label", "Loading");
    const spinner = document.createElement("span");
    spinner.className = "optimisticSpinner";
    spinner.setAttribute("aria-hidden", "true");
    const srText = document.createElement("span");
    srText.className = "srOnly";
    srText.textContent = "Loading";
    status.append(spinner, srText);
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "action danger";
    cancelBtn.dataset.cancel = item.token;
    cancelBtn.textContent = "Cancel";
    actTd.append(status, cancelBtn);
    tr.appendChild(actTd);

    return tr;
  }

  renderGauge(server, optimistic) {
    if (!this.gaugeFill || !this.gaugeText) return;
    const cap = server.capSeconds || 80 * 60;
    const optimisticSeconds = optimistic.reduce((acc, o) => acc + (o.duration || 0), 0);
    const used = (server.totalSeconds || 0) + optimisticSeconds;
    const pct = Math.min(100, Math.round((used / cap) * 100));

    this.gaugeFill.style.width = pct + "%";
    this.gaugeFill.style.opacity = used > cap ? "0.6" : "1";
    this.gaugeFill.style.filter = used > cap ? "grayscale(1)" : "none";
    this.gaugeText.textContent = `${fmtTime(used)} / ${fmtTime(cap)}`;
  }
}

const dotsAnimator = new DotsAnimator(dom.overlayDots);
const overlay = new OverlayController({
  root: dom.overlayRoot,
  title: dom.overlayTitle,
  subtitle: dom.overlaySubtitle,
  thumbFrame: dom.overlayThumbFrame,
  thumb: dom.overlayThumb,
  thumbSkeleton: dom.overlayThumbSkeleton,
  disc: dom.overlayDisc,
});
const playlistRenderer = new PlaylistRenderer({
  body: dom.listBody,
  gaugeFill: dom.gaugeFill,
  gaugeText: dom.gaugeText,
});

function debounce(fn, ms = 220) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[m]);
}

function isYouTubeUrl(str) {
  try {
    const u = new URL(str.trim());
    const host = u.hostname.replace(/^www\./, "");
    return (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be" ||
      host.endsWith(".youtube.com")
    );
  } catch (e) {
    return false;
  }
}

function youTubeIdFrom(input) {
  if (!input) return null;
  try {
    const u = new URL(input.trim());
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).slice(0, 11);
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && v.length === 11) return v;
      const m = u.pathname.match(/^\/(shorts|embed)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch (e) {
    // ignore
  }
  const m = String(input).match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function keyFor(url) {
  return youTubeIdFrom(url) || url.trim();
}

function makeToken() {
  return `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function setButtonsEnabled(on) {
  dom.btnAdd.disabled = !on;
  dom.btnMp3.disabled = !on;
  dom.btnWav.disabled = !on;
}

function updateActionButtons() {
  const hasItems = state.server.items.length > 0;
  const hasPendingAdds = state.optimisticAdds.length > 0;
  dom.downloadZipBtn.disabled = !hasItems || hasPendingAdds;
  if (dom.downloadZipBtn) {
    if (hasPendingAdds) {
      dom.downloadZipBtn.title = "Please wait for pending tracks to finish adding before downloading.";
    } else {
      dom.downloadZipBtn.removeAttribute("title");
    }
  }
  dom.clearBtn.disabled = !hasItems && state.optimisticAdds.length === 0;
}

function showThumbById(id) {
  if (!dom.thumb || !dom.thumbWrap) return;
  if (!id) {
    hideThumb();
    return;
  }

  dom.thumbWrap.classList.add("show");
  if (dom.thumbSkeleton) dom.thumbSkeleton.style.display = "block";
  dom.thumb.style.display = "none";

  dom.thumb.onload = () => {
    dom.thumb.style.display = "block";
    if (dom.thumbSkeleton) dom.thumbSkeleton.style.display = "none";
    dom.thumbWrap.classList.add("show");
  };
  dom.thumb.onerror = hideThumb;
  dom.thumb.style.minHeight = "1px";
  dom.thumb.src = `/thumb/${id}?t=${Date.now()}`;
}

function hideThumb() {
  if (dom.thumb) {
    dom.thumb.removeAttribute("src");
    dom.thumb.style.display = "none";
  }
  if (dom.thumbSkeleton) dom.thumbSkeleton.style.display = "none";
  if (dom.thumbWrap) dom.thumbWrap.classList.remove("show");
}

function setPickedNoteIdle() {
  if (!dom.pickedNote) return;
  dom.pickedNote.textContent = "We’ll auto-pick the best source (Opus > AAC, ≥ 44 kHz).";
}

function setPickedNotePicked(bf) {
  if (!dom.pickedNote) return;
  if (!bf) {
    setPickedNoteIdle();
    return;
  }
  const abr = bf.abr ? `${bf.abr} kbps` : bf.tbr ? `${Math.round(bf.tbr)} kbps` : "—";
  const asr = bf.asr ? `${bf.asr} Hz` : "—";
  dom.pickedNote.innerHTML = `Picked: <strong>${esc(bf.acodec || "")}</strong> · ${esc(abr)} · ${esc(asr)} · id <code>${esc(bf.id)}</code>`;
}

function setPickedNoteError(msg) {
  if (!dom.pickedNote) return;
  dom.pickedNote.innerHTML = `<span style="color:#ff8a8a">${esc(msg)}</span>`;
}

function syncUI() {
  playlistRenderer.render(state.server, state.optimisticAdds);
  refreshOptimisticLoadingIndicators();
  updateActionButtons();
}

function buildSessionHeaders(headers) {
  const merged = new Headers(headers || {});
  if (sessionHint && !merged.has("X-CD-Session")) {
    merged.set("X-CD-Session", sessionHint);
  }
  return merged;
}

async function sessionFetch(input, init = {}) {
  const opts = { ...init };
  opts.credentials = init.credentials || "same-origin";
  opts.headers = buildSessionHeaders(init.headers);
  const response = await fetch(input, opts);
  try {
    const hinted = response?.headers?.get?.("x-cd-session");
    if (hinted) {
      sessionHint = hinted;
    }
  } catch (err) {
    // ignore header access issues
  }
  return response;
}

async function refresh() {
  const requestId = ++refreshRequestId;
  const r = await sessionFetch("/api/list");
  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText || "Request failed");
    throw new Error(msg || `Request failed with status ${r.status}`);
  }

  const next = await r.json();
  const nextItems = Array.isArray(next?.items) ? next.items.slice() : [];
  nextItems.sort((a, b) => {
    const oa = orderValueOf(a);
    const ob = orderValueOf(b);
    const aFinite = Number.isFinite(oa);
    const bFinite = Number.isFinite(ob);
    if (aFinite && bFinite) return oa - ob;
    if (aFinite) return -1;
    if (bFinite) return 1;
    return 0;
  });
  const currentItems = Array.isArray(state.server.items) ? state.server.items : [];
  const hasPendingAdds = state.optimisticAdds.length > 0 || pendingAddRequests.size > 0;

  if (requestId !== refreshRequestId) {
    return null;
  }

  if (hasPendingAdds && nextItems.length < currentItems.length) {
    return null;
  }

  state.server = {
    capSeconds:
      typeof next?.capSeconds === "number" ? next.capSeconds : state.server.capSeconds,
    totalSeconds:
      typeof next?.totalSeconds === "number" ? next.totalSeconds : state.server.totalSeconds,
    items: nextItems,
  };

  if (!Array.isArray(state.server.items)) state.server.items = [];
  updateOrderCursorFromServerItems(state.server.items);
  syncUI();
  return state.server;
}

function stopOptimisticLoading(token) {
  if (!token) return;
  const indicator = optimisticLoadingIndicators.get(token);
  if (!indicator) return;
  if (indicator.timer) clearInterval(indicator.timer);
  optimisticLoadingIndicators.delete(token);
}

function ensureOptimisticLoadingIndicator(token, el) {
  if (!token || !el) return;
  let indicator = optimisticLoadingIndicators.get(token);
  if (!indicator) {
    indicator = {};
    optimisticLoadingIndicators.set(token, indicator);
  }
  indicator.el = el;
  if (!el.querySelector(".optimisticSpinner")) {
    el.textContent = "";
    const spinner = document.createElement("span");
    spinner.className = "optimisticSpinner";
    spinner.setAttribute("aria-hidden", "true");
    const srText = document.createElement("span");
    srText.className = "srOnly";
    srText.textContent = "Loading";
    el.append(spinner, srText);
  }
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-busy", "true");
  el.setAttribute("aria-label", "Loading");
}

function refreshOptimisticLoadingIndicators() {
  const tokens = new Set(state.optimisticAdds.map((entry) => entry.token).filter(Boolean));
  const stale = [];
  optimisticLoadingIndicators.forEach((_, token) => {
    if (!tokens.has(token)) stale.push(token);
  });
  stale.forEach((token) => stopOptimisticLoading(token));

  if (!dom.listBody) return;

  state.optimisticAdds.forEach((entry) => {
    if (!entry?.token) return;
    const row = dom.listBody.querySelector(`tr[data-optimistic-token="${entry.token}"]`);
    if (!row) return;
    const status = row.querySelector(".optimisticProgress");
    if (!status) return;
    ensureOptimisticLoadingIndicator(entry.token, status);
  });
}

function updateOptimisticEntry(token, patch) {
  const entry = state.optimisticAdds.find((o) => o.token === token);
  if (!entry) return;
  Object.assign(entry, patch);
  syncUI();
}

function removeOptimisticEntry(token, { silent = false } = {}) {
  stopOptimisticLoading(token);
  const idx = state.optimisticAdds.findIndex((o) => o.token === token);
  if (idx === -1) return;
  state.optimisticAdds.splice(idx, 1);
  if (!silent) syncUI();
}

async function probe(url, { fast = false } = {}) {
  const r = await sessionFetch("/api/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, fast }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function ensureBackgroundProbe(url) {
  const key = keyFor(url);
  if (!key) return;
  let entry = probeCache.get(key);
  if (!entry) {
    entry = { pendingFast: false, pendingSmart: false };
    probeCache.set(key, entry);
  }

  if (!entry.fast && !entry.pendingFast) {
    entry.pendingFast = true;
    probe(url, { fast: true })
      .then((d) => {
        entry.fast = d;
        entry.pendingFast = false;
        entry.ts = Date.now();
      })
      .catch(() => {
        entry.pendingFast = false;
      });
  }

  if (!entry.smart && !entry.pendingSmart) {
    entry.pendingSmart = true;
    probe(url, { fast: false })
      .then((d) => {
        entry.smart = d;
        entry.pendingSmart = false;
        entry.ts = Date.now();
      })
      .catch(() => {
        entry.pendingSmart = false;
      });
  }
}

function bestCachedData(url) {
  const key = keyFor(url);
  if (!key) return null;
  const cache = probeCache.get(key);
  return cache?.smart || cache?.fast || null;
}

function buildThumbSources(items) {
  return items
    .map((item) => {
      if (item?.videoId) return `/thumb/${item.videoId}`;
      if (item?.thumbnail) return item.thumbnail;
      return null;
    })
    .filter(Boolean)
    .map((src, idx) => `${src}${src.includes("?") ? "&" : "?"}t=${Date.now() + idx}`);
}

async function handleAddToCd() {
  const url = dom.url.value.trim();
  if (!url) return;

  hideThumb();
  const token = makeToken();
  const orderHint = state.nextOrderHint++;
  const optimistic = {
    token,
    title: "Loading…",
    duration: 0,
    orderHint,
    createdAt: Date.now(),
  };
  state.optimisticAdds.push(optimistic);
  syncUI();

  dom.url.value = "";
  dom.url.focus();
  setButtonsEnabled(false);

  let data = bestCachedData(url);
  let bestFormat = data?.bestFormat || null;
  let usedClient = data?.usedClient || null;

  if (data) {
    updateOptimisticEntry(token, {
      title: data.title || optimistic.title,
      duration: Number(data.duration || 0),
    });
  } else {
    try {
      data = await probe(url, { fast: true });
      bestFormat = data.bestFormat || null;
      usedClient = data.usedClient || null;
      updateOptimisticEntry(token, {
        title: data.title || optimistic.title,
        duration: Number(data.duration || 0),
      });
      ensureBackgroundProbe(url);
    } catch (e) {
      // ignore, we'll still try to add
    }
  }

  const controller = new AbortController();
  pendingAddRequests.set(token, controller);
  try {
    const payload = bestFormat
      ? {
          url,
          format_id: bestFormat.id,
          client_token: token,
          used_client: usedClient || null,
        }
      : { url, client_token: token, used_client: usedClient || null };

    const r = await sessionFetch("/api/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!r.ok) throw new Error(await r.text());
    const resBody = await r.json();

    if (resBody?.canceled) {
      removeOptimisticEntry(token, { silent: true });
      syncUI();
      return;
    }

    removeOptimisticEntry(token, { silent: true });

    if (resBody?.item) {
      if (!Array.isArray(state.server.items)) state.server.items = [];
      const items = state.server.items;
      const incoming = resBody.item;
      const existingIdx = items.findIndex((entry) => entry?.id === incoming.id);
      if (existingIdx !== -1) {
        items.splice(existingIdx, 1);
      }
      insertServerItemOrdered(items, incoming);
      if (typeof resBody.totalSeconds === "number") {
        state.server.totalSeconds = resBody.totalSeconds;
      }
      if (typeof resBody.capSeconds === "number") {
        state.server.capSeconds = resBody.capSeconds;
      }
      syncUI();
      pendingAddRequests.delete(token);
      try {
        await refresh();
      } catch (err) {
        console.warn("Failed to refresh playlist after add:", err);
      }
      return;
    }

    await refresh();
  } catch (e) {
    if (controller.signal.aborted) {
      const stillPending = state.optimisticAdds.some((o) => o.token === token);
      if (stillPending) {
        removeOptimisticEntry(token, { silent: true });
        syncUI();
      }
      return;
    }
    setPickedNoteError("Failed to add this link.");
    removeOptimisticEntry(token);
  } finally {
    pendingAddRequests.delete(token);
  }
}

function describeFormat(bf) {
  if (!bf) return "";
  const parts = [];
  if (bf.acodec) parts.push(String(bf.acodec).toUpperCase());
  if (bf.abr) parts.push(`${bf.abr} kbps`);
  if (bf.asr) parts.push(`${bf.asr} Hz`);
  if (bf.id) parts.push(`id ${bf.id}`);
  return parts.join(" · ");
}

function triggerBrowserDownload(href) {
  if (!href) return false;
  let url;
  try {
    url = new URL(href, window.location.origin).toString();
  } catch (err) {
    url = href;
  }

  const iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");

  let cleanupTimer = null;

  const cleanup = () => {
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
    setTimeout(() => {
      if (iframe.parentNode) {
        iframe.remove();
      }
    }, 1000);
  };

  iframe.addEventListener("load", cleanup, { once: true });
  iframe.addEventListener("error", () => {
    cleanup();
    try {
      window.location.assign(url);
    } catch {
      window.location.href = url;
    }
  }, { once: true });

  cleanupTimer = setTimeout(cleanup, 60_000);
  document.body.appendChild(iframe);
  return true;
}

async function oneOffDownload(target) {
  const url = dom.url.value.trim();
  if (!url) return;

  const ytId = youTubeIdFrom(url);
  const thumbSrc = ytId ? `/thumb/${ytId}?t=${Date.now()}` : null;
  overlay.showConversion({
    title: `Preparing your ${target.toUpperCase()}`,
    subtitle: "",
    thumbSrc,
  });
  dotsAnimator.start();

  const cached = bestCachedData(url);
  let bestFormat = cached?.bestFormat || null;

  if (bestFormat) {
    overlay.setSubtitle(describeFormat(bestFormat));
  }

  if (!cached) ensureBackgroundProbe(url);

  try {
    const body = {
      url,
      target,
      format_id: bestFormat?.id || undefined,
      used_client: cached?.usedClient || null,
    };

    const r = await sessionFetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const txt = await r.text();
      let msg = `Failed to get ${target.toUpperCase()}`;
      let formats = null;
      let chosen = null;
      let picker = null;
      try {
        const j = JSON.parse(txt);
        msg = `${j.error || "Error"}: ${j.message || j.detail || msg}`;
        formats = j.formats || null;
        chosen = j.chosen || null;
        picker = j.picker || null;
      } catch (err) {
        // ignore
      }
      if (formats && Array.isArray(formats) && formats.length) {
        const lines = formats
          .slice()
          .sort((a, b) => (b.asr || 0) - (a.asr || 0) || (b.abr || 0) - (a.abr || 0))
          .map((f) => {
            const parts = [
              `id ${f.id}`,
              f.vcodec ? `v=${String(f.vcodec)}` : "",
              f.acodec ? `a=${String(f.acodec)}` : "",
              f.asr ? `${f.asr}Hz` : "",
              typeof f.abr === "number"
                ? `${f.abr}kbps`
                : typeof f.tbr === "number"
                ? `${Math.round(f.tbr)}kbps`
                : "",
              f.ext || "",
              f.note ? `(${f.note})` : "",
            ].filter(Boolean);
            return "• " + parts.join(" · ");
          })
          .join("\n");
        if (dom.pickedNote) {
          dom.pickedNote.innerHTML = `
            <div class="fmt-debug">
              <div style="color:#ff8a8a; margin-bottom:6px;">${esc(msg)}${
            picker ? `<br><span class="subtle">${esc(picker)}</span>` : ""
          }</div>
              ${
                chosen
                  ? `<div class="subtle">Tried format: <code>${esc(chosen.id)}</code> (${esc(
                      chosen.acodec || ""
                    )}, ${chosen.asr || "?"}Hz, ${chosen.abr || "?"}kbps)</div>`
                  : ""
              }
              <details open>
                <summary>Available formats (${formats.length})</summary>
                <pre class="fmt-pre">${esc(lines)}</pre>
              </details>
            </div>`;
        }
      } else {
        setPickedNoteError(msg);
      }
      return;
    }

    const result = await r.json().catch(() => null);
    const href = result?.href;
    if (!result?.ok || !href) {
      setPickedNoteError(result?.message || "Download link was not provided.");
      return;
    }
    triggerBrowserDownload(href);
  } catch (e) {
    setPickedNoteError(`Network error: ${e.message || e}`);
  } finally {
    dotsAnimator.stop();
    overlay.hide();
  }
}

async function handleZipDownload() {
  if (!state.server.items.length) return;
  if (state.optimisticAdds.length) return;

  overlay.showZip({
    title: "Bundling your CD",
    subtitle: `${state.server.items.length} track${state.server.items.length === 1 ? "" : "s"} will be zipped.`,
    thumbnails: buildThumbSources(state.server.items),
  });
  dotsAnimator.start();

  try {
    const r = await sessionFetch("/api/zip", { method: "POST" });
    if (!r.ok) {
      const txt = await r.text();
      setPickedNoteError(`Failed to create ZIP: ${txt || r.statusText}`);
      return;
    }
    const result = await r.json().catch(() => null);
    const href = result?.href;
    if (!result?.ok || !href) {
      setPickedNoteError(result?.message || "Failed to prepare ZIP download.");
      return;
    }
    triggerBrowserDownload(href);
  } catch (e) {
    setPickedNoteError(`Failed to create ZIP: ${e.message || e}`);
  } finally {
    dotsAnimator.stop();
    overlay.hide();
  }
}

async function handleRemove(id) {
  if (!id) return;
  const items = Array.isArray(state.server.items) ? state.server.items : [];
  const idx = items.findIndex((item) => item?.id === id);
  let removed = null;
  if (idx !== -1) {
    removed = items.splice(idx, 1)[0];
    if (removed?.duration && typeof state.server.totalSeconds === "number") {
      state.server.totalSeconds = Math.max(
        0,
        state.server.totalSeconds - Number(removed.duration || 0)
      );
    }
    syncUI();
  }

  try {
    const res = await sessionFetch(`/api/remove/${id}`, { method: "POST" });
    if (!res.ok) {
      if (res.status === 404) {
        await refresh();
        return;
      }
      const txt = await res.text();
      throw new Error(txt || `remove failed: ${res.status}`);
    }
    const body = await res.json();
    if (body && typeof body.totalSeconds === "number") {
      state.server.totalSeconds = body.totalSeconds;
    }
    if (body && typeof body.capSeconds === "number") {
      state.server.capSeconds = body.capSeconds;
    }
    syncUI();
  } catch (err) {
    if (removed && idx !== -1) {
      items.splice(Math.min(idx, items.length), 0, removed);
    }
    await refresh();
  }
}

function handleCancel(token) {
  if (!token) return;
  const controller = pendingAddRequests.get(token);
  if (controller) controller.abort();
  removeOptimisticEntry(token);
  sessionFetch("/api/cancel-add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    keepalive: true,
  }).catch(() => {});
}

async function handleClear() {
  if (!confirm("Clear the whole list and delete files?")) return;
  state.optimisticAdds.length = 0;
  optimisticLoadingIndicators.forEach((_, token) => stopOptimisticLoading(token));
  state.nextOrderHint = 1;
  await sessionFetch("/api/clear", { method: "POST" });
  await refresh();
}

function extractServerOrderFromDom() {
  if (!dom.listBody) return [];
  return Array.from(dom.listBody.querySelectorAll("tr[data-item-id]"))
    .map((row) => row.dataset.itemId)
    .filter(Boolean);
}

function applyOrderToState(order) {
  if (!Array.isArray(order)) return false;
  const items = Array.isArray(state.server.items) ? state.server.items : [];
  if (order.length !== items.length) return false;
  const map = new Map(items.map((item) => [item.id, item]));
  if (order.some((id) => !map.has(id))) return false;
  const currentOrders = items
    .map((item) => orderValueOf(item))
    .filter((value) => Number.isFinite(value));
  const base = currentOrders.length ? Math.max(...currentOrders) + 1 : 1;
  order.forEach((id, idx) => {
    const entry = map.get(id);
    if (entry) entry.order = base + idx;
  });
  state.server.items = order.map((id) => map.get(id));
  updateOrderCursorFromServerItems(state.server.items);
  return true;
}

function initReorderDrag() {
  if (!dom.listBody) return;

  let dragCtx = null;

  const cleanup = (pointerId) => {
    if (!dragCtx) return;
    dragCtx.row.classList.remove("dragging");
    if (typeof pointerId === "number" && dragCtx.row.releasePointerCapture) {
      try {
        dragCtx.row.releasePointerCapture(pointerId);
      } catch {}
    }
    dragCtx = null;
  };

  dom.listBody.addEventListener("pointerdown", (event) => {
    if (event.isPrimary === false) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const row = event.target.closest("tr[data-item-id]");
    if (!row) return;
    if (!row.dataset.itemId) return;
    if (event.target.closest("button, a, input, textarea, select")) return;
    const serverCount = Array.isArray(state.server.items) ? state.server.items.length : 0;
    if (serverCount <= 1) return;

    dragCtx = {
      row,
      pointerId: event.pointerId,
      startOrder: extractServerOrderFromDom(),
    };
    row.classList.add("dragging");
    if (row.setPointerCapture) {
      try {
        row.setPointerCapture(event.pointerId);
      } catch {}
    }
    event.preventDefault();
  });

  dom.listBody.addEventListener("pointermove", (event) => {
    if (!dragCtx || event.pointerId !== dragCtx.pointerId) return;
    dragCtx.moved = true;
    event.preventDefault();

    const rows = Array.from(dom.listBody.querySelectorAll("tr[data-item-id]"));
    if (!rows.length) return;

    const draggingIndex = rows.indexOf(dragCtx.row);
    if (draggingIndex === -1) return;

    const { clientX, clientY } = event;
    let targetRow = document.elementFromPoint(clientX, clientY)?.closest("tr[data-item-id]");

    if (!targetRow) {
      const bodyRect = dom.listBody.getBoundingClientRect();
      if (clientY < bodyRect.top) {
        const first = rows[0];
        if (first && first !== dragCtx.row) {
          dom.listBody.insertBefore(dragCtx.row, first);
        }
      } else if (clientY > bodyRect.bottom) {
        const last = rows[rows.length - 1];
        if (last && last !== dragCtx.row) {
          dom.listBody.insertBefore(dragCtx.row, last.nextSibling);
        }
      }
      return;
    }

    if (targetRow === dragCtx.row) return;

    const targetIndex = rows.indexOf(targetRow);
    if (targetIndex === -1) return;

    if (targetIndex < draggingIndex) {
      dom.listBody.insertBefore(dragCtx.row, targetRow);
    } else {
      dom.listBody.insertBefore(dragCtx.row, targetRow.nextSibling);
    }
  });

  const finishDrag = (canceled = false) => {
    if (!dragCtx) return;
    const pointerId = dragCtx.pointerId;
    const startOrder = dragCtx.startOrder;
    const moved = dragCtx.moved;
    cleanup(pointerId);

    if (!moved || canceled) {
      if (canceled) {
        syncUI();
      }
      return;
    }

    const newOrder = extractServerOrderFromDom();
    if (newOrder.length !== startOrder.length) {
      refresh();
      return;
    }
    const changed = newOrder.some((id, idx) => id !== startOrder[idx]);
    if (!changed) {
      return;
    }

    if (!applyOrderToState(newOrder)) {
      refresh();
      return;
    }

    syncUI();

    sessionFetch("/api/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: newOrder }),
    }).then((r) => {
      if (!r.ok) {
        throw new Error("Reorder failed");
      }
    }).catch(() => {
      refresh();
    });
  };

  dom.listBody.addEventListener("pointerup", (event) => {
    if (!dragCtx || event.pointerId !== dragCtx.pointerId) return;
    finishDrag(false);
  });

  dom.listBody.addEventListener("pointercancel", (event) => {
    if (!dragCtx || event.pointerId !== dragCtx.pointerId) return;
    finishDrag(true);
  });
}

function onUrlChanged() {
  const url = dom.url.value.trim();
  const valid = isYouTubeUrl(url);
  setButtonsEnabled(valid);
  if (valid) {
    const id = youTubeIdFrom(url);
    if (id) showThumbById(id);
    ensureBackgroundProbe(url);
  } else {
    hideThumb();
  }
}

function setDisclaimerVisibility(show) {
  if (!dom.disclaimerOverlay) return;
  const isShown = Boolean(show);
  dom.disclaimerOverlay.hidden = !isShown;
  dom.disclaimerOverlay.setAttribute("aria-hidden", isShown ? "false" : "true");
  if (dom.disclaimerLink) {
    dom.disclaimerLink.setAttribute("aria-expanded", isShown ? "true" : "false");
  }

  if (isShown) {
    lastDisclaimerTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : dom.disclaimerLink;
    const focusTarget =
      (dom.disclaimerClose && typeof dom.disclaimerClose.focus === "function"
        ? dom.disclaimerClose
        : dom.disclaimerOverlay.querySelector(
            'button, [href], [tabindex]:not([tabindex="-1"])'
          )) || null;
    focusTarget?.focus?.();
  } else if (lastDisclaimerTrigger && typeof lastDisclaimerTrigger.focus === "function") {
    lastDisclaimerTrigger.focus();
    lastDisclaimerTrigger = null;
  }
}

initThemeToggle();

dom.btnAdd.addEventListener("click", handleAddToCd);
dom.btnMp3.addEventListener("click", () => oneOffDownload("mp3"));
dom.btnWav.addEventListener("click", () => oneOffDownload("wav"));
dom.downloadZipBtn.addEventListener("click", handleZipDownload);
dom.clearBtn.addEventListener("click", handleClear);

if (dom.disclaimerLink) {
  dom.disclaimerLink.addEventListener("click", (event) => {
    event.preventDefault();
    setDisclaimerVisibility(true);
  });
}

if (dom.disclaimerClose) {
  dom.disclaimerClose.addEventListener("click", () => setDisclaimerVisibility(false));
}

if (dom.disclaimerOverlay) {
  dom.disclaimerOverlay.addEventListener("click", (event) => {
    if (event.target === dom.disclaimerOverlay) {
      setDisclaimerVisibility(false);
    }
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dom.disclaimerOverlay && !dom.disclaimerOverlay.hidden) {
    setDisclaimerVisibility(false);
  }
});

dom.listBody.addEventListener("click", (event) => {
  const target = event.target.closest("button[data-remove]");
  if (target) {
    handleRemove(target.dataset.remove);
    return;
  }
  const cancel = event.target.closest("button[data-cancel]");
  if (cancel) {
    handleCancel(cancel.dataset.cancel);
  }
});

initReorderDrag();

dom.url.addEventListener("input", debounce(onUrlChanged, 120));
dom.url.addEventListener("paste", () => setTimeout(onUrlChanged, 0));
dom.url.addEventListener("blur", onUrlChanged);

refresh();
setPickedNoteIdle();
setButtonsEnabled(false);
updateActionButtons();

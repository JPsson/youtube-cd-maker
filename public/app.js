const urlEl        = document.getElementById("url");
const btnAdd       = document.getElementById("btnAdd");
const btnMp3       = document.getElementById("btnMp3");
const btnWav       = document.getElementById("btnWav");
const pickedNoteEl = document.getElementById("pickedNote");

const thumbWrap = document.querySelector(".thumbWrap");
const thumbEl      = document.getElementById("thumb");
const thumbSkelEl  = document.getElementById("thumbSkeleton");

const listBody  = document.getElementById("listBody");
const gaugeFill = document.getElementById("gaugeFill");
const gaugeText = document.getElementById("gaugeText");
const clearBtn  = document.getElementById("clear");

const overlay   = document.getElementById("overlay");

let dotsTick = 0;
let lastServerState = { capSeconds: 80*60, totalSeconds: 0, items: [] }; // cache
const optimistic = []; // { token, title, duration, el: <tr> }

// ===== Background probe cache =====
// key: videoId || normalized URL
// value: { fast?: data, smart?: data, pendingFast?:bool, pendingSmart?:bool, ts:number }
const probeCache = new Map();

// ---------- helpers ----------
function debounce(fn, ms=220){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
function fmtTime(s){ s=Math.max(0,Math.floor(s||0)); const m=Math.floor(s/60), ss=s%60; return `${m}:${String(ss).padStart(2,"0")}`; }
function esc(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function isYouTubeUrl(str){
  try {
    const u=new URL(str.trim()); const h=u.hostname.replace(/^www\./,'');
    return h==="youtube.com"||h==="m.youtube.com"||h==="youtu.be"||h.endsWith(".youtube.com");
  } catch { return false; }
}
function youTubeIdFrom(input){
  if (!input) return null;
  try {
    const u = new URL(input.trim());
    const host = u.hostname.replace(/^www\./,'');
    if (host==="youtu.be") return u.pathname.slice(1).slice(0,11);
    if (host==="youtube.com" || host.endsWith(".youtube.com")) {
      const v = u.searchParams.get("v"); if (v && v.length===11) return v;
      const m = u.pathname.match(/^\/(shorts|embed)\/([A-Za-z0-9_-]{11})/); if (m) return m[2];
    }
  } catch {}
  const m = String(input).match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function keyFor(url){ return youTubeIdFrom(url) || url.trim(); }

function setButtonsEnabled(on){
  btnAdd.disabled = !on; btnMp3.disabled = !on; btnWav.disabled = !on;
}
function showThumbById(id){
  if (!id) { hideThumb(); return; }

  // show wrapper immediately (skeleton optional)
  if (thumbWrap) thumbWrap.classList.add("show");
  if (thumbSkelEl) thumbSkelEl.style.display = "block";
  thumbEl.style.display = "none";

  // use your proxy route (or swap to i.ytimg.com if you prefer)
  const src = `/thumb/${id}?t=${Date.now()}`;

  thumbEl.onload = () => {
    thumbEl.style.display = "block";
    if (thumbSkelEl) thumbSkelEl.style.display = "none";
    if (thumbWrap) thumbWrap.classList.add("show"); // ensure visible
  };
  thumbEl.onerror = () => { hideThumb(); };

  // guard against zero-height edge cases
  thumbEl.style.minHeight = "1px";
  thumbEl.src = src;
}

function hideThumb(){
  if (thumbEl) { thumbEl.removeAttribute("src"); thumbEl.style.display = "none"; }
  if (thumbSkelEl) thumbSkelEl.style.display = "none";
  if (thumbWrap) thumbWrap.classList.remove("show");
}

function setPickedNoteIdle(){
  pickedNoteEl.textContent = "We’ll auto-pick the best source (Opus > AAC, ≥ 44 kHz).";
}
function setPickedNotePicked(bf){
  if (!bf) return setPickedNoteIdle();
  const abr = bf.abr ? `${bf.abr} kbps` : (bf.tbr ? `${Math.round(bf.tbr)} kbps` : "—");
  const asr = bf.asr ? `${bf.asr} Hz` : "—";
  pickedNoteEl.innerHTML = `Picked: <strong>${esc(bf.acodec || "")}</strong> · ${esc(abr)} · ${esc(asr)} · id <code>${esc(bf.id)}</code>`;
}
function setPickedNoteError(msg){ pickedNoteEl.innerHTML = `<span style="color:#ff8a8a">${esc(msg)}</span>`; }

function startOverlay(){
  overlay.style.display = "grid";
}
function stopOverlay(){
  overlay.style.display = "none";
}
setInterval(()=>{ dotsTick=(dotsTick+1)%4; const d=document.getElementById("dots"); if (d) d.textContent=".".repeat(dotsTick); }, 400);

function makeToken(){ return `tmp_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }

// ---------- rendering ----------
function renderServerRows(){
  listBody.innerHTML = "";
  for (const it of (lastServerState.items || [])){
    const tr = document.createElement("tr");

    const tdTitle = document.createElement("td");
    tdTitle.textContent = it.title;
    tr.appendChild(tdTitle);

    const tdDur   = document.createElement("td");
    tdDur.className = "colDur";
    tdDur.textContent = fmtTime(it.duration);
    tr.appendChild(tdDur);

    const tdAct   = document.createElement("td");
    tdAct.className = "colAct";
    tdAct.innerHTML = `<button class="action danger" data-id="${it.id}">Remove</button>`;
    tr.appendChild(tdAct);

    listBody.appendChild(tr);
  }
  // wire removes
  [...document.querySelectorAll("button[data-id]")].forEach(btn=>{
    btn.onclick = async () => { await fetch(`/api/remove/${btn.dataset.id}`, { method:"POST" }); await refresh(); };
  });
  // optimistic rows (prepend)
  for (const o of optimistic){
    if (!o.el){
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(o.title || "Loading…")}</td>
        <td class="colDur">${o.duration ? fmtTime(o.duration) : "—"}</td>
        <td class="colAct"><span class="subtle">Adding…</span> <button class="action danger" data-otk="${o.token}">Remove</button></td>
      `;
      o.el = tr;
    } else {
      o.el.children[0].textContent = o.title || "Loading…";
      o.el.children[1].textContent = o.duration ? fmtTime(o.duration) : "—";
    }
    listBody.prepend(o.el);
  }
  // optimistic remove
  [...document.querySelectorAll("button[data-otk]")].forEach(btn=>{
    btn.onclick = () => {
      const tok = btn.dataset.otk;
      const idx = optimistic.findIndex(x => x.token === tok);
      if (idx !== -1) {
        optimistic[idx].el?.remove();
        optimistic.splice(idx, 1);
        updateGauge();
      }
    };
  });
}

function updateGauge(){
  const cap = lastServerState.capSeconds || (80*60);
  const optimisticSeconds = optimistic.reduce((a,o)=> a + (o.duration || 0), 0);
  const used = (lastServerState.totalSeconds || 0) + optimisticSeconds;

  const pct = Math.min(100, Math.round((used/cap)*100));
  gaugeFill.style.width = pct + "%";
  gaugeText.textContent = `${fmtTime(used)} / ${fmtTime(cap)}`;
  gaugeFill.style.opacity = used > cap ? "0.6" : "1";
  gaugeFill.style.filter  = used > cap ? "grayscale(1)" : "none";
}

async function refresh(){
  const r = await fetch("/api/list");
  lastServerState = await r.json();
  renderServerRows();
  updateGauge();
}

// ---------- API helpers ----------
async function probe(url, { fast = false } = {}) {
  const r = await fetch("/api/probe", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ url, fast })
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------- Background probe orchestration (silent) ----------
async function ensureBackgroundProbe(url){
  const key = keyFor(url);
  if (!key) return;
  let entry = probeCache.get(key);
  if (!entry) { entry = { pendingFast:false, pendingSmart:false }; probeCache.set(key, entry); }

  // Fast (web) — quickest title/duration
  if (!entry.fast && !entry.pendingFast){
    entry.pendingFast = true;
    probe(url, { fast: true })
      .then(d => { entry.fast = d; entry.pendingFast = false; entry.ts = Date.now(); })
      .catch(()=>{ entry.pendingFast = false; });
  }
  // Smart (parallel server-side) — richer formats
  if (!entry.smart && !entry.pendingSmart){
    entry.pendingSmart = true;
    probe(url, { fast: false })
      .then(d => { entry.smart = d; entry.pendingSmart = false; entry.ts = Date.now(); })
      .catch(()=>{ entry.pendingSmart = false; });
  }
}

// ---------- Add To CD (optimistic, uses cache first) ----------
btnAdd.addEventListener("click", async () => {
  const url = urlEl.value.trim();
  if (!url) return;

  // Hide thumb and create instant placeholder
  hideThumb();
  const token = makeToken();
  const opt = { token, title: "Loading…", duration: 0, el: null };
  optimistic.push(opt);
  renderServerRows();
  updateGauge();

  // keep input free for next paste
  urlEl.value = "";
  urlEl.focus();

  // Use cached probe if available (prefer smart > fast)
  const key = keyFor(url);
  const cache = key ? probeCache.get(key) : null;
  let data = cache?.smart || cache?.fast || null;
  let best = data?.bestFormat || null;
  let usedClient = data?.usedClient || null;

  if (data) {
    opt.title = data.title || opt.title;
    opt.duration = Number(data.duration || 0);
    renderServerRows();
    updateGauge();
  } else {
    // fallback: quick fast probe (still silent; no UI text)
    try {
      data = await probe(url, { fast: true });
      best = data.bestFormat || null;
      usedClient = data.usedClient || null;
      opt.title = data.title || opt.title;
      opt.duration = Number(data.duration || 0);
      renderServerRows();
      updateGauge();
      // keep cache warm
      ensureBackgroundProbe(url);
    } catch {/* ignore; we'll still try to add */}
  }

  try {
    const payload = best
      ? { url, format_id: best.id, client_token: token, used_client: usedClient || null }
      : { url, client_token: token, used_client: usedClient || null };

    const r = await fetch("/api/add", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(await r.text());

    const idx = optimistic.findIndex(x => x.token === token);
    if (idx !== -1) { optimistic[idx].el?.remove(); optimistic.splice(idx, 1); }
    await refresh();

  } catch (e) {
    setPickedNoteError("Failed to add this link.");
    const idx = optimistic.findIndex(x => x.token === token);
    if (idx !== -1) { optimistic[idx].el?.remove(); optimistic.splice(idx, 1); }
    updateGauge();
  }
});

// ---------- One-off MP3/WAV (overlay shows instantly; uses cache if possible) ----------
async function oneOffDownload(target){
  const url = urlEl.value.trim();
  if (!url) return;

  // Overlay immediately with neutral message (no "analyzing" cue)
  const loaderTextEl = document.querySelector(".loaderText");
  loaderTextEl.innerHTML = `Preparing your file<span id="dots">.</span>`;
  startOverlay();

  // Prefer cached smart > fast; if none, we can still call /api/convert without fmtId
  const key = keyFor(url);
  const cache = key ? probeCache.get(key) : null;
  const cachedData = cache?.smart || cache?.fast || null;

  // If cached format exists, show details right away
  let bf = cachedData?.bestFormat || null;
  if (bf) {
    const abr = bf.abr ? `${bf.abr} kbps` : (bf.tbr ? `${Math.round(bf.tbr)} kbps` : "—");
    const asr = bf.asr ? `${bf.asr} Hz` : "—";
    loaderTextEl.innerHTML = `Preparing your file<span id="dots">.</span><br><span class="subtle">${esc(bf.acodec || "")} · ${esc(abr)} · ${esc(asr)} · id <code>${esc(bf.id)}</code></span>`;
  }

  // If nothing cached yet, kick background probes (silent); we won’t wait to show text
  if (!cachedData) ensureBackgroundProbe(url);

  try{
    // Build request using whatever we know; server can still choose best if no fmtId
    const body = {
      url,
      target,
      format_id: bf?.id || undefined,
      used_client: (cachedData && cachedData.usedClient) || null
    };

    const r = await fetch("/api/convert", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const txt = await r.text();
      let msg = `Failed to get ${target.toUpperCase()}`;
      let formats = null, chosen = null, picker = null;
      try {
        const j = JSON.parse(txt);
        msg = `${j.error || 'Error'}: ${j.message || j.detail || msg}`;
        formats = j.formats || null;
        chosen  = j.chosen  || null;
        picker  = j.picker  || null;
      } catch {}
      if (formats && Array.isArray(formats) && formats.length) {
        const lines = formats
          .slice()
          .sort((a,b) => (b.asr||0)-(a.asr||0) || (b.abr||0)-(a.abr||0))
          .map(f => {
            const parts = [
              `id ${f.id}`,
              (f.vcodec ? `v=${String(f.vcodec)}` : ""),
              (f.acodec ? `a=${String(f.acodec)}` : ""),
              (f.asr ? `${f.asr}Hz` : ""),
              (typeof f.abr==="number" ? `${f.abr}kbps` : (typeof f.tbr==="number" ? `${Math.round(f.tbr)}kbps` : "")),
              (f.ext ? f.ext : ""),
              (f.note ? `(${f.note})` : "")
            ].filter(Boolean);
            return "• " + parts.join(" · ");
          })
          .join("\n");
        pickedNoteEl.innerHTML =
          `<div class="fmt-debug">
             <div style="color:#ff8a8a; margin-bottom:6px;">${esc(msg)}${picker ? `<br><span class="subtle">${esc(picker)}</span>` : ""}</div>
             ${chosen ? `<div class="subtle">Tried format: <code>${esc(chosen.id)}</code> (${esc(chosen.acodec||"")}, ${chosen.asr||"?"}Hz, ${chosen.abr||"?"}kbps)</div>` : ""}
             <details open>
               <summary>Available formats (${formats.length})</summary>
               <pre class="fmt-pre">${esc(lines)}</pre>
             </details>
           </div>`;
      } else {
        setPickedNoteError(msg);
      }
      return;
    }

    // success: stream download
    const cd = r.headers.get("Content-Disposition") || "";
    const fn = /filename="([^"]+)"/.exec(cd)?.[1] || `audio.${target}`;
    const blob = await r.blob();
    const href = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href, download: fn });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(href);

  } catch (e){
    setPickedNoteError(`Network error: ${e.message || e}`);
  } finally {
    stopOverlay();
  }
}
btnMp3.addEventListener("click", () => oneOffDownload("mp3"));
btnWav.addEventListener("click", () => oneOffDownload("wav"));

// ---------- URL handling (silent background prefetch) ----------
function onUrlChanged(){
  const url = urlEl.value.trim();
  const valid = isYouTubeUrl(url);
  setButtonsEnabled(valid);
  if (valid){
    const id = youTubeIdFrom(url);
    if (id) showThumbById(id);
    // kick off background probes silently
    ensureBackgroundProbe(url);
  } else {
    hideThumb();
  }
}
urlEl.addEventListener("input", debounce(onUrlChanged, 120));
urlEl.addEventListener("paste", () => setTimeout(onUrlChanged, 0));
urlEl.addEventListener("blur", onUrlChanged);

// ---------- housekeeping ----------
clearBtn.addEventListener("click", async () => {
  if (!confirm("Clear the whole list and delete files?")) return;
  optimistic.splice(0, optimistic.length);
  await fetch("/api/clear", { method: "POST" });
  await refresh();
});

refresh();
setPickedNoteIdle();
setButtonsEnabled(false);

// Gate scanner. Staff hold the event's gate code; every call is code-checked against the gate.
import { configured, esc, typo, fmtTime, fmtCode, store, I, paintIcons, plural, wireThemeToggles } from "./core.js";
import * as fb from "./firebase.js";
import { Camera, decode, tokenFrom } from "./scanner.js";

const $ = (id) => document.getElementById(id);
const joinEl = $("join"), scanEl = $("scan");
const S = {
  code: null, gate: "Gate 1", event: null,
  device: store.get("gp.device") || Math.random().toString(36).slice(2, 10),
  last: { token: null, seen: 0, text: null, textSeen: 0 },
  busy: false, loopOn: false,
};
store.set("gp.device", S.device);
paintIcons();
wireThemeToggles();
$("findBtn").innerHTML = I.search;
$("photoLbl").innerHTML = I.camera;
document.querySelectorAll(".fine").forEach((p) => { p.innerHTML = p.innerHTML.replace("${search}", `<span class="hint-ico">${I.search}</span>`).replace("${camera}", `<span class="hint-ico">${I.camera}</span>`); });

// ── sound + buzz (unlocked on the first tap) ──
let ac;
function unlockAudio() { try { ac ||= new (window.AudioContext || window.webkitAudioContext)(); ac.resume?.(); } catch {} }
document.addEventListener("pointerdown", unlockAudio, { once: true });
function tone(freq, start, dur, type = "sine", gain = 0.2) {
  if (!ac) return;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, ac.currentTime + start);
  g.gain.exponentialRampToValueAtTime(gain, ac.currentTime + start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur);
  o.connect(g).connect(ac.destination);
  o.start(ac.currentTime + start); o.stop(ac.currentTime + start + dur + 0.05);
}
const sounds = {
  ok() { tone(988, 0, 0.11, "sine", 0.25); tone(1480, 0.12, 0.16, "sine", 0.25); navigator.vibrate?.(70); },
  dup() { tone(150, 0, 0.5, "sawtooth", 0.22); tone(155, 0, 0.5, "square", 0.08); navigator.vibrate?.([90, 60, 90, 60, 220]); },
  warn() { tone(440, 0, 0.14, "triangle", 0.2); tone(330, 0.16, 0.2, "triangle", 0.2); navigator.vibrate?.([50, 40, 50]); },
};

// ── verdict ──
const verdictEl = $("verdict");
function verdict(kind, main, sub = "") {
  const ico = { ok: I.okDot, okoff: I.okDot, dup: I.xDot, warn: I.warnDot, hold: I.warnDot, idle: I.idleDot }[kind];
  verdictEl.className = `verdict ${kind}`;
  verdictEl.innerHTML = `<span class="v-ico">${ico}</span><div class="v-text"><p class="v-main">${main}</p>${sub ? `<p class="v-sub">${sub}</p>` : ""}</div>`;
  if (kind !== "idle") { void verdictEl.offsetWidth; verdictEl.classList.add("pop"); }
  // "Name · First scan" reads as one line at the gate: step the size down before letting it wrap.
  if (kind === "ok" || kind === "okoff") {
    const m = verdictEl.querySelector(".v-main");
    let px = parseFloat(getComputedStyle(m).fontSize);
    m.style.whiteSpace = "nowrap";
    while (m.scrollWidth > m.clientWidth && px > 20) m.style.fontSize = `${--px}px`;
    m.style.whiteSpace = "";
  }
}
function flash(kind) {
  const f = $("flash");
  f.className = `flash ${kind}`;
  f.innerHTML = kind === "ok" ? I.bigCheck : I.bigX;
  void f.offsetWidth;
  f.classList.add("show");
}
const idle = () => verdict("idle", "Point the camera at a pass", "The first scan lets them in. Any repeat goes red on every phone.");
const isOffline = (e) => /unavailable|deadline-exceeded|network/i.test(e.code || "");

function setCounts(c) {
  if (!c) return;
  $("cNum").textContent = `${c.checked} / ${c.total}`;
  $("cBar").style.setProperty("--p", c.total ? Math.min(1, c.checked / c.total) : 0);
}

// ── offline gate mode ────────────────────────────────────────────
// The gate must not die with the venue's network. While online the page
// caches the roster on THIS phone (localStorage, keyed by gate code —
// exactly the rows this code already entitles the phone to read). A scan
// with no signal is validated against that cache: a known, unchecked
// pass is provisionally accepted and queued; the queue replays through
// the real claim path (fb.scanToken with the original scan instant) when
// signal returns. Claims stay the only authority — a provisional accept
// is a promise to claim, never a claim itself.
let serverCounts = null;      // last counts the server vouched for
let flushing = false;
let statsOffline = false;     // the stats listener's own reachability signal

const cacheKey = () => `gp.roster.${S.code}`;
const queueKey = () => `gp.queue.${S.code}`;
const loadCache = () => (S.code ? store.get(cacheKey()) : null);
const loadQueue = () => (S.code ? store.get(queueKey(), []) : []);
const saveQueue = (q) => { if (S.code) store.set(queueKey(), q); };

function renderCounts() {
  if (!serverCounts) return;
  const pending = loadQueue().filter((e) => e.kind === "scan").length;
  setCounts({ total: serverCounts.total, checked: serverCounts.checked + pending, bounced: serverCounts.bounced });
}

// Rebuild the roster cache from the server: roster rows with checked-in
// state overlaid from the claim docs (the authority — the roster stamp
// is legacy and scans no longer write it).
async function refreshRosterCache() {
  if (!S.code) return;
  try {
    const [rows, claims] = await Promise.all([fb.getGateRoster(S.code), fb.getClaims(S.code)]);
    if (!rows) return;
    const byId = new Map(claims.map((c) => [c.pass_id, c]));
    for (const r of rows) {
      const c = byId.get(r.id);
      if (c?.scanned_at) { r.checkedInAt = c.scanned_at; r.gate = c.gate || r.gate || ""; }
    }
    store.set(cacheKey(), { at: new Date().toISOString(), event: S.event, rows });
  } catch { /* keep the last good cache — it is what offline scans read */ }
}

// After an online result, keep the cache's picture of that one pass
// current without a full roster re-read.
function patchCacheRow(match, r) {
  const cache = loadCache();
  const row = cache?.rows.find(match);
  if (!row) return;
  if (r.status === "ok") { row.checkedInAt = r.scanned_at; row.gate = S.gate; }
  else if (r.status === "dup" && !row.checkedInAt) { row.checkedInAt = r.first_at; row.gate = r.first_gate || row.gate; }
  store.set(cacheKey(), cache);
}

// Is this pass already in, per everything this phone knows (server
// claims as cached + this session's offline queue)?
function queuedScan(passId) {
  return loadQueue().find((e) => e.passId === passId && e.kind === "scan") || null;
}
function knownFirstScan(row) {
  if (row.checkedInAt) return { at: row.checkedInAt, gate: row.gate || "" };
  const q = queuedScan(row.id);
  return q ? { at: q.scannedAt, gate: q.gate } : null;
}

// Find-by-name against the cache, same shape and prefix semantics as
// fb.gateFind: the dead-phone fallback must not need a signal either.
function cacheFindRows(text) {
  const q = text.trim().toLowerCase();
  if (q.length < 2) return [];
  return (loadCache()?.rows || [])
    .filter((r) => (r.name || "").toLowerCase().startsWith(q))
    .slice(0, 8)
    .map((r) => {
      const first = knownFirstScan(r);
      return { id: r.id, name: r.name, hint: r.hint, checked_in_at: first?.at || null, gate: first?.gate || "" };
    });
}

function pushRecentLocal(name, isFirst, at) {
  const li = document.createElement("li");
  li.innerHTML = `
    <span class="${isFirst ? "r-ok" : "r-dup"}">${isFirst ? I.check : I.x}</span>
    <span class="r-name">${esc(name)}</span>
    <span class="r-at">${isFirst ? "" : "repeat · "}${esc(S.gate)} · ${esc(fmtTime(at))} · offline</span>`;
  const list = $("recent");
  list.prepend(li);
  while (list.children.length > 6) list.lastElementChild.remove();
}

// The offline scan itself: validate one token against the cache and
// queue the outcome. Unknown passes are NEVER waved through — with no
// signal there is nothing to verify them against.
function offlineScan(token) {
  const row = loadCache()?.rows.find((r) => r.token === token) || null;
  const at = new Date().toISOString();
  if (!row) {
    sounds.warn();
    verdict("hold", "Can't verify offline",
      "This pass isn't in the list saved on this phone. Check their ID, or let the organiser decide — a scan alone can't let them in right now.");
    return;
  }
  const first = knownFirstScan(row);
  const entry = {
    uid: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    passId: row.id, token, name: row.name, gate: S.gate, device: S.device, scannedAt: at,
  };
  if (first) {
    saveQueue([...loadQueue(), { ...entry, kind: "repeat" }]);
    flash("dup"); sounds.dup();
    verdict("dup", `Already scanned at ${esc(fmtTime(first.at))}`,
      `${esc(row.name)} · first scan at ${esc(first.gate || S.gate)} · <span class="v-tag">Offline repeat — will sync</span>`);
  } else {
    saveQueue([...loadQueue(), { ...entry, kind: "scan" }]);
    flash("ok"); sounds.ok();
    verdict("okoff", `${esc(row.name)} <span class="sep">· First scan</span>`,
      `Let them in · ${esc(fmtTime(at))} · <span class="v-tag">Offline — will sync</span>`);
  }
  pushRecentLocal(row.name, !first, at);
  renderCounts();
  renderSyncBar();
}

// ── sync: replay the queue through the real claim path ───────────
async function flushQueue() {
  if (!S.code || flushing || !navigator.onLine) { renderSyncBar(); return; }
  if (!loadQueue().length) { renderSyncBar(); return; }
  flushing = true;
  renderSyncBar();
  let synced = 0, conflicts = 0, dropped = 0, blocked = false;
  try {
    for (;;) {
      const head = loadQueue()[0];
      if (!head) break;
      let r;
      try {
        r = await fb.scanToken(S.code, head.token, head.gate, head.device, { at: head.scannedAt });
      } catch (e) {
        // Still no network: the rest of the queue stays put, in order.
        // A rules denial (e.g. the site rules predate the offline window)
        // also stops the flush — but says so, instead of spinning forever.
        if (e.code === "permission-denied") blocked = true;
        break;
      }
      if (r.status === "bad_code") {
        // The code rotated while this phone was offline: these scans can
        // never land under it. Drop the dead queue and leave, exactly as
        // an online bad-code scan does.
        store.del(queueKey());
        flushing = false;
        sounds.warn();
        leave("The organiser changed this gate's code. Ask them for the new one.");
        return;
      }
      // The entry resolved — remove exactly it, and only now. A crash or
      // a dropped connection before this line leaves it queued, and the
      // passId-keyed claim makes a re-flush safe (never a double claim).
      saveQueue(loadQueue().filter((e) => e.uid !== head.uid));
      if (r.status === "ok") synced++;
      else if (r.status === "dup") conflicts++;   // claimed elsewhere meanwhile; scanToken recorded it as a repeat
      else dropped++;                              // unknown / wrong event: the pass is no longer valid
      if (r.counts) serverCounts = r.counts;
    }
  } finally {
    flushing = false;
  }
  const pending = loadQueue().length;
  if (synced || conflicts || dropped || pending || blocked) {
    S.lastSummary = blocked
      ? "Sync is blocked — the site rules need re-publishing by the organiser. Scans stay saved on this phone."
      : `Synced ${synced} · ${conflicts} already scanned elsewhere · ${pending} pending${dropped ? ` · ${dropped} no longer valid` : ""}`;
  }
  if (synced || conflicts) { refreshRosterCache(); loadStats(); }
  // A resolved scanToken call is proof the server answered, whatever the
  // stats listener last reported.
  if (synced || conflicts || dropped) statsOffline = false;
  renderCounts();
  renderSyncBar();
}

// ── connection pill + sync bar ───────────────────────────────────
function renderSyncBar() {
  const pill = $("connPill");
  if (!pill || !S.code) return;
  const off = !navigator.onLine || statsOffline;
  pill.classList.toggle("off", off);
  $("connText").textContent = off ? "Offline — saving on this phone" : "Online";
  const n = loadQueue().length;
  const pend = $("syncPending");
  pend.hidden = n === 0;
  pend.textContent = n ? `${plural(n, "scan")} waiting to sync` : "";
  const btn = $("syncBtn");
  btn.hidden = !(n > 0 && !off);
  btn.disabled = flushing;
  btn.textContent = flushing ? "Syncing…" : "Sync now";
  const sum = $("syncSummary");
  sum.hidden = !S.lastSummary;
  sum.textContent = S.lastSummary || "";
}
$("syncBtn").addEventListener("click", () => flushQueue());
window.addEventListener("online", () => { renderSyncBar(); flushQueue(); });
window.addEventListener("offline", () => renderSyncBar());

function showResult(r) {
  if (!r) return;
  if (r.counts) serverCounts = r.counts;
  renderCounts();
  switch (r.status) {
    case "ok":
      flash("ok"); sounds.ok();
      verdict("ok", `${esc(r.name)} <span class="sep">· First scan</span>`, `Let them in · ${esc(fmtTime(r.scanned_at))}`);
      break;
    case "dup":
      flash("dup"); sounds.dup();
      verdict("dup", `Already scanned at ${esc(fmtTime(r.first_at))}`,
        `${esc(r.name)} · first scan at ${esc(r.first_gate)}${r.same_device ? " (this phone)" : ""} · ${plural(r.repeats, "repeat")}`);
      break;
    case "wrong_event":
      sounds.warn(); verdict("warn", "Pass for another event", "This QR is a GatePass pass, but not for this event. Don't let them in on it.");
      break;
    case "unknown":
      sounds.warn(); verdict("warn", "Not on the list", "This pass isn't in this event's registrations.");
      break;
    case "bad_code":
      sounds.warn(); leave("The organiser changed this gate's code. Ask them for the new one.");
      return;
  }
  loadStats();
}

async function scanToken(token) {
  S.busy = true;
  // Immediate pending state: a check-in round-trip can take seconds, and a
  // silent scanner reads as a dead scanner (live test, 27 Nov 2026). Every
  // check-in path — camera, photo, find-by-name, manual entry — funnels
  // through here or admitById below, and all of them show this first.
  verdict("idle", "Checking…", "Confirming this pass with the gate list.");
  try {
    // The browser already knows it's offline: don't wait on a doomed
    // round-trip, validate against the cached roster right away.
    if (!navigator.onLine) { offlineScan(token); return; }
    const r = await fb.scanToken(S.code, token, S.gate, S.device);
    if (r.status === "bad_code") { sounds.warn(); return leave("The organiser changed this gate's code. Ask them for the new one."); }
    patchCacheRow((row) => row.token === token, r);
    showResult(r);
  } catch (e) {
    // The browser thought it was online but the write/read died on the
    // network: same offline path, not a dead end.
    if (isOffline(e)) { renderSyncBar(); offlineScan(token); return; }
    sounds.warn();
    verdict("warn", "Couldn't check that pass", esc(e.message));
    S.last.token = null;
  } finally {
    S.busy = false;
  }
}

// Called with every decoded QR text (camera, photo, or tests).
async function handleText(text) {
  const now = Date.now();
  const token = tokenFrom(text);
  if (!token) {
    if (text === S.last.text && now - S.last.textSeen < 3000) { S.last.textSeen = now; return; }
    S.last.text = text; S.last.textSeen = now;
    sounds.warn(); verdict("warn", "Not a GatePass QR", "That code isn't an entry pass.");
    return;
  }
  // The same pass sitting in front of the camera is one scan, not twenty.
  if (token === S.last.token && now - S.last.seen < 3500) { S.last.seen = now; return; }
  if (S.busy) return;
  S.last.token = token; S.last.seen = now;
  await scanToken(token);
}
window.GatePassGate = { handleText }; // handy for testing in the console

// ── stats ──
function loadStats() {
  if (!S.code) return;
  fb.gateStats(S.code);
}
window.addEventListener("gp-stats", (e) => {
  if (!S.code) return;
  const d = e.detail;
  if (!d) return;
  if (d.badCode) return leave("The organiser changed this gate's code. Ask them for the new one.");
  statsOffline = !!d.offline;
  renderSyncBar();
  // An offline dispatch carries the listener's last-known (or zeroed)
  // counts and recent list: never let it erase what this phone already
  // knows — the local offline rows and the queued-scan overlay are the
  // truth until a real snapshot lands.
  if (d.offline) return;
  serverCounts = d.counts;
  renderCounts();
  $("recent").innerHTML = d.recent.length ? d.recent.map((r) => `
    <li>
      <span class="${r.is_first ? "r-ok" : "r-dup"}">${r.is_first ? I.check : I.x}</span>
      <span class="r-name">${esc(r.name)}</span>
      <span class="r-at">${r.is_first ? "" : "repeat · "}${esc(r.gate)} · ${esc(fmtTime(r.at))}</span>
    </li>`).join("") : `<li><span class="r-at">Nobody scanned yet.</span></li>`;
});

// ── camera ──
const cam = new Camera($("video"));
const camMsg = $("camMsg"), viewport = $("viewport");
function camMessage(title, body, action) {
  camMsg.innerHTML = `<h3>${title}</h3><p>${body}</p>${action ? `<button class="btn small" type="button" id="camAct">${action}</button>` : ""}`;
  camMsg.hidden = false;
  camMsg.querySelector("#camAct")?.addEventListener("click", () => { unlockAudio(); startCamera(); });
}
async function startCamera() {
  camMsg.hidden = true;
  try {
    await cam.start();
  } catch (e) {
    viewport.classList.remove("hunting");
    if (e.kind === "denied") return camMessage("Camera blocked", "Allow camera access for this site in your browser settings, then try again. Meanwhile, use Find by name.", "Try again");
    if (e.kind === "none") return camMessage("No camera found", "Use Find by name or Scan a photo below.", "Try again");
    if (e.kind === "unsupported") return camMessage("Camera unavailable", "Open this page in Chrome or Safari (not inside Instagram) to use the camera. Find by name still works.", null);
    return camMessage("Camera didn't start", esc(e.message), "Try again");
  }
  viewport.classList.add("hunting");
  renderCamTools();
  loop();
}
function renderCamTools() {
  const t = $("camTools");
  t.innerHTML = `${cam.canTorch ? `<button class="icon-btn" type="button" id="torch" aria-pressed="false" aria-label="Torch">${I.torch}</button>` : ""}${cam.canFlip ? `<button class="icon-btn" type="button" id="flip" aria-label="Switch camera">${I.flip}</button>` : ""}`;
  t.querySelector("#torch")?.addEventListener("click", async (e) => { const on = await cam.torch(); e.currentTarget.setAttribute("aria-pressed", String(on)); });
  t.querySelector("#flip")?.addEventListener("click", async () => { await cam.flip(); renderCamTools(); });
}
async function loop() {
  if (S.loopOn) return;
  S.loopOn = true;
  const video = $("video");
  while (cam.running && !scanEl.hidden) {
    if (document.visibilityState === "visible" && video.readyState >= 2 && !S.busy) {
      try {
        const text = await decode(video);
        if (text) await handleText(text);
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 110));
  }
  S.loopOn = false;
}

// ── photo fallback ──
$("photo").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const text = await decode(bmp, { maxSide: 1400 });
    if (text) { S.last.token = null; await handleText(text); }
    else { sounds.warn(); verdict("warn", "No QR in that photo", "Get closer so the QR fills most of the picture."); }
  } catch { verdict("warn", "Couldn't read that photo", "Try another one."); }
});

// ── find by name ──
$("findBtn").addEventListener("click", openFind);
function openFind() {
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="findT">
      <div class="sheet-top"><h2 class="head" id="findT" style="font-size:24px">Find by name</h2>
        <button class="icon-btn" type="button" id="closeFind" aria-label="Close">${I.x}</button></div>
      <p class="sub" style="margin-bottom:12px">For a dead phone or a cracked screen. Check their ID before you let them in.</p>
      <div class="search"><span>${I.search}</span><input class="input" id="q" placeholder="Type 2+ letters of their name" autocomplete="off" enterkeyhint="search"></div>
      <ul class="passlist" id="found" style="margin-top:12px"></ul>
    </div>`;
  document.body.append(bg);
  const close = () => { bg.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
  bg.querySelector("#closeFind").addEventListener("click", close);
  const q = bg.querySelector("#q"), list = bg.querySelector("#found");
  q.focus();
  let t, seq = 0;
  q.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const mine = ++seq;
      if (q.value.trim().length < 2) { list.innerHTML = ""; return; }
      let rows = [];
      if (!navigator.onLine) rows = cacheFindRows(q.value);
      else {
        try { rows = await fb.gateFind(S.code, q.value); }
        catch (e) {
          if (isOffline(e)) { renderSyncBar(); rows = cacheFindRows(q.value); }
          else { list.innerHTML = `<li><p class="err">Couldn't search. Check your connection.</p></li>`; return; }
        }
      }
      if (mine !== seq) return;
      list.innerHTML = rows.length ? rows.map((r) => `
        <li>
          <p class="pl-name">${esc(r.name)}</p>
          <p class="pl-meta">${esc(r.hint || "no contact")}${r.checked_in_at ? ` · <span style="color:var(--stop);font-weight:700">in at ${esc(fmtTime(r.checked_in_at))} · ${esc(r.gate)}</span>` : ""}</p>
          <div class="pl-actions"><button class="btn small" type="button" data-id="${r.id}">${r.checked_in_at ? "Check" : "Let in"}</button></div>
        </li>`).join("") : `<li><p class="pl-meta" style="grid-column:1/-1">Nobody by that name in this event.</p></li>`;
    }, 220);
  });
  list.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    b.disabled = true;
    close();
    // Offline (or the connection dies on the way): admit from the cache
    // row — the same provisional path a scanned QR takes.
    const cacheRow = () => loadCache()?.rows.find((r) => r.id === b.dataset.id) || null;
    if (!navigator.onLine) {
      const row = cacheRow();
      if (row) return offlineScan(row.token);
      sounds.warn();
      return verdict("hold", "Can't verify offline", "That guest isn't in the list saved on this phone.");
    }
    verdict("idle", "Checking…", "Confirming this guest's pass.");
    try {
      const r = await fb.admitById(S.code, b.dataset.id, S.gate, S.device);
      if (r.status === "bad_code") { sounds.warn(); leave("The organiser changed this gate's code. Ask them for the new one."); }
      else { patchCacheRow((row) => row.id === b.dataset.id, r); showResult(r); }
    }
    catch (err) {
      if (isOffline(err)) {
        renderSyncBar();
        const row = cacheRow();
        if (row) return offlineScan(row.token);
        sounds.warn();
        return verdict("hold", "Can't verify offline", "That guest isn't in the list saved on this phone.");
      }
      verdict("warn", "Couldn't check them in", esc(err.message));
    }
  });
}

// ── join / leave ──
function showJoin(msg = "") {
  scanEl.hidden = true; joinEl.hidden = false;
  const err = $("joinErr");
  err.textContent = msg; err.hidden = !msg;
}
function leave(msg = "") {
  cam.stop(); fb.stopStats();
  S.code = null; S.lastSummary = null; serverCounts = null; statsOffline = false;
  store.del("gp.gate");
  showJoin(msg);
}
$("leaveBtn").addEventListener("click", () => leave());

function showScanner() {
  joinEl.hidden = true; scanEl.hidden = false;
  $("evName").textContent = typo(S.event.name);
  $("gateName").textContent = S.gate;
  document.title = `${S.gate} · ${typo(S.event.name)} · GatePass`;
  serverCounts = S.event.counts;
  renderCounts();
  idle();
  loadStats();
  renderSyncBar();
}

// No signal, but this phone has been to this gate before: open the
// scanner on the cached roster + event. Scans queue locally and sync
// when signal returns — the door never closes for a dead network.
function enterOfflineScanner(code, gate) {
  const norm = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const cache = store.get(`gp.roster.${norm}`);
  if (!cache?.event || !cache.rows) return false;
  S.code = norm; S.gate = gate; S.event = cache.event; S.lastSummary = null;
  store.set("gp.gate", { code: S.code, gate });
  statsOffline = true;
  showScanner();
  verdict("idle", "You're offline", "Scans save on this phone and sync when signal returns. New passes sold since this list was saved can't be verified until you're back online.");
  camMessage("You're offline", "The camera still works — scans save on this phone and sync when signal returns.", "Start camera");
  return true;
}

async function join(code, gate, { auto = false } = {}) {
  const btn = $("joinBtn");
  const label = btn.querySelector(".label");
  btn.disabled = true;
  // Visible feedback while the code validates — a greyed button with its
  // original label and no other sign of life reads as a hang.
  if (label) label.textContent = "Checking code…";
  try {
    const ev = await fb.joinGate(code);
    if (!ev) { if (auto) store.del("gp.gate"); return showJoin(auto ? "" : "No event has that code. Check it with the organiser; they may have made a new one."); }
    S.code = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase(); S.gate = gate; S.event = ev; S.lastSummary = null;
    store.set("gp.gate", { code: S.code, gate });
    showScanner();
    // Build/refresh the offline roster cache while we have signal, and
    // replay anything a previous offline session left queued.
    refreshRosterCache();
    flushQueue();
    const perm = await navigator.permissions?.query?.({ name: "camera" }).catch(() => null);
    if (!auto || perm?.state === "granted") startCamera();
    else camMessage("Ready", "Tap to turn on the camera.", "Start camera");
  } catch (e) {
    if (isOffline(e) && enterOfflineScanner(code, gate)) return;
    showJoin(isOffline(e) ? "No connection. Connect and try again." : e.message);
  } finally {
    btn.disabled = false;
    if (label) label.textContent = "Open scanner";
  }
}

// ── manual pass entry ──
// No camera, no photo, name not found: staff paste the guest's pass link
// (or the bare token from it) and the pass goes through the exact same
// claim path and verdicts as a scanned QR.
$("manualForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("manualInput"), err = $("manualErr");
  const token = tokenFrom(input.value);
  if (!token) {
    err.textContent = "That doesn't look like a pass link or code. Paste the guest's whole pass link.";
    err.hidden = false;
    input.focus();
    return;
  }
  err.hidden = true;
  if (S.busy) return;
  S.last.token = null;   // a deliberate manual entry always re-checks, even a repeat
  await scanToken(token);
  input.value = "";
});

const codeIn = $("code");
codeIn.addEventListener("input", () => {
  const raw = codeIn.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
  codeIn.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
  $("joinErr").hidden = true;
});
$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  unlockAudio();
  const raw = codeIn.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (raw.length !== 8) return showJoin("The gate code has 8 letters and numbers, like K7QM-2XPA.");
  const gate = new FormData(e.target).get("gate") || "Gate 1";
  join(raw, gate);
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.code) loadStats(); });

// ── boot ──
(function boot() {
  if (!configured || !fb.configured) { showJoin("This copy of GatePass has no Firebase project configured yet."); return; }
  const fromHash = (location.hash || "").replace(/^#\/?/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const saved = store.get("gp.gate");
  if (fromHash.length === 8) {
    codeIn.value = fmtCode(fromHash);
    history.replaceState(null, "", location.pathname);
    if (saved?.code === fromHash) return join(saved.code, saved.gate, { auto: true });
    return showJoin();
  }
  if (saved?.code) return join(saved.code, saved.gate || "Gate 1", { auto: true });
  showJoin();
})();

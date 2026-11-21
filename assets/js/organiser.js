// Organiser app: sign in, events, registrations → passes, links, gate code, live counter.
import {
  configured, ART, artUrl, passUrl, gateUrl, fmtCode, fmtWhen, fmtTime, fmtDay, esc, plural,
  copyText, toast, download, qrSvg, I, paintIcons, DB_MSG, escT, typo,
} from "./core.js";
import * as fb from "./firebase.js";
import { parseTable, analyse, toPasses, toCsv, isEmail, isPhone } from "./csv.js";

const view = document.getElementById("view");
const roleEl = document.getElementById("role");
let session = null;
let live = null;

const MAX_ROWS = 5000;

// ─────────────────────────────────────────────── boot

function notConfigured() {
  view.innerHTML = `
    <section class="stack narrow">
      <div class="poster hero-poster" id="art"><h1 class="poster-title ink">Almost there</h1><p class="poster-club">Connect your Firebase project</p></div>
      <ol class="sub" style="padding-left:20px;margin:6px 0 0;display:grid;gap:6px">
        <li>Create a free project at console.firebase.google.com.</li>
        <li>Enable Firestore and Google sign-in (see <b>SETUP.md</b>).</li>
        <li>Put your web config in <b>firebase-config.js</b>.</li>
      </ol>
      <a class="btn" href="https://github.com/Souradip121/gatepass#host-your-own-copy-free-5-steps" rel="noopener">Read the 5-step guide ${I.open}</a>
    </section>`;
  view.querySelector("#art").style.backgroundImage = `url("${artUrl(0)}")`;
}

async function boot() {
  if (!configured || !fb.configured) return notConfigured();
  session = await new Promise((resolve) => fb.onAuth(resolve));
  await fb.redirectResult().catch(() => {});
  fb.onAuth((u) => {
    const was = !!session;
    session = u;
    if (!was && u) route();
    if (was && !u) { session = null; route(); }
  });
  window.addEventListener("hashchange", route);
  route();
}

function route() {
  stopLive();
  const h = location.hash || "";
  if (route.last !== undefined && route.last !== h) window.scrollTo(0, 0);
  route.last = h;
  if (!session) return signInView();
  roleEl.innerHTML = `Organiser <button class="icon-btn" type="button" id="signout" title="Sign out (${esc(session.email || "")})" aria-label="Sign out" style="width:36px;height:36px;margin-left:4px">${I.out}</button>`;
  roleEl.querySelector("#signout").addEventListener("click", async () => { await fb.signOutUser(); location.hash = ""; });
  const m = h.match(/^#\/e\/([0-9a-f-]{36})(\/edit)?$/);
  if (h === "#/new") return eventForm();
  if (m) return m[2] ? eventForm(m[1]) : eventView(m[1]);
  return listView();
}

function fail(e) {
  const msg = e?.message || String(e);
  const signature = `${e?.code || ""} ${msg}`;
  const paused = /unavailable|deadline-exceeded|network|fetch|5\d\d/.test(signature) ? DB_MSG + " Or check your connection." : msg;
  view.innerHTML = `<section class="empty"><h3>Something broke</h3><p class="sub">${esc(paused)}</p><p style="margin-top:14px"><button class="btn small" type="button" onclick="location.reload()">${I.refresh}Try again</button></p></section>`;
}

// ─────────────────────────────────────────────── sign in

function signInView(errMsg = "") {
  roleEl.textContent = "Organiser";
  document.title = "GatePass · free QR entry passes for club events";
  view.innerHTML = `
    <section class="signin">
      <div class="poster hero-poster" id="art">
        <h1 class="poster-title ink">Free entry passes</h1>
        <p class="poster-club">For your club's next event</p>
        <span class="poster-when">Open source · ₹0</span>
      </div>
      <div class="stack" style="margin-top:14px">
        <p class="sub" style="font-size:17px;color:var(--blue)">Upload your registrations sheet and everyone gets their own QR pass. At the gate, any phone becomes the scanner. A screenshot of a pass works once.</p>
        <p class="err" id="sErr" role="alert" ${errMsg ? "" : "hidden"}>${esc(errMsg)}</p>
        <button class="btn-primary compact" type="button" id="google"><span class="gdisc">${I.google}</span><span class="label">Continue with Google</span><span class="arrow">${I.arrow}</span></button>
        <p class="fine" style="margin:0">Organisers sign in with Google. Gate staff and attendees never need an account.</p>
        <div class="links" style="margin-top:8px">
          <a href="gate/">${I.qr} Gate staff? Join with a code</a>
          <a href="https://github.com/Souradip121/gatepass" rel="noopener">${I.open} Host your own copy</a>
        </div>
      </div>
    </section>`;
  view.querySelectorAll(".links svg").forEach((s) => { s.style.width = "18px"; s.style.height = "18px"; });
  view.querySelector("#art").style.backgroundImage = `url("${artUrl(0)}")`;
  view.querySelector("#google").addEventListener("click", async () => {
    try { await fb.signIn(); }
    catch (e) { const err = view.querySelector("#sErr"); err.textContent = e.message; err.hidden = false; }
  });
}

// ─────────────────────────────────────────────── events list

async function listView() {
  document.title = "Your events · GatePass";
  view.innerHTML = `<div class="skeleton" style="height:220px"></div>`;
  let data;
  try {
    const idx = await fb.listEvents(session.uid);
    data = await Promise.all(idx.map(async (e) => {
      const full = await fb.getEvent(e.id);
      const gate = full ? await fb.joinGate(full.gate_code) : null;
      return {
        id: e.id, name: full?.name || e.name, club: full?.club || "",
        starts_at: full?.starts_at || e.starts_at, venue: full?.venue || "",
        art: full?.art || 0,
        total: gate?.counts.total || 0, checked: gate?.counts.checked || 0,
      };
    }));
  } catch (e) { return fail(e); }
  const now = Date.now();
  const stubs = data.map((e) => {
    const total = e.total ?? 0, checked = e.checked ?? 0;
    const past = new Date(e.starts_at).getTime() < now - 12 * 3600e3;
    return `
      <a class="stub" href="#/e/${e.id}" style="${past ? "opacity:.72" : ""}">
        <span class="stub-art" style="background-image:url('${artUrl(e.art, true)}')"></span>
        <span class="stub-body">
          <span class="stub-name ink">${escT(e.name)}</span>
          <span class="stub-meta">${esc(fmtWhen(e.starts_at))}${e.venue ? ` · ${esc(e.venue)}` : ""}</span>
        </span>
        <span class="stub-count">${checked} / ${total}<small>${total ? "checked in" : "no passes yet"}</small></span>
      </a>`;
  }).join("");
  view.innerHTML = `
    <section class="stack narrow">
      <div class="head-row"><h1 class="head">Your events</h1></div>
      ${data.length ? stubs : `
        <div class="empty">
          <h3>No events yet</h3>
          <p class="sub" style="color:var(--blue)">Make one, drop in your registrations sheet, and every row gets a pass.</p>
        </div>`}
      <a class="btn-primary compact" href="#/new" style="margin-top:6px"><span class="tix">${I.ticket}</span><span class="label">New event</span><span class="arrow">${I.arrow}</span></a>
    </section>`;
}

// ─────────────────────────────────────────────── create / edit event

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  return d;
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

async function eventForm(id = null) {
  let ev = { name: "", club: "", venue: "", art: 0, starts_at: null };
  if (id) {
    try {
      const data = await fb.getEvent(id);
      if (!data) { location.hash = ""; return; }
      ev = data;
    } catch (e) { return fail(e); }
  }
  const when = ev.starts_at ? new Date(ev.starts_at) : (() => { const d = nextSaturday(); d.setHours(18, 0, 0, 0); return d; })();
  document.title = `${id ? "Edit" : "New"} event · GatePass`;
  view.innerHTML = `
    <div class="narrow">
    <a class="backlink" href="${id ? `#/e/${id}` : "#"}">${I.back}${id ? "Back to the event" : "Your events"}</a>
    <form id="evForm" class="stack" novalidate>
      <h1 class="head">${id ? "Edit event" : "New event"}</h1>
      <label class="field"><span>Event name</span><input class="input" name="name" maxlength="80" required placeholder="e.g. Freshers’ Night 2026" value="${esc(ev.name)}"></label>
      <label class="field"><span>Club</span><input class="input" name="club" maxlength="80" placeholder="e.g. Photography Club" value="${esc(ev.club)}"></label>
      <div class="two">
        <label class="field"><span>Date</span><input class="input" type="date" name="date" required value="${ymd(when)}"></label>
        <label class="field"><span>Time</span><input class="input" type="time" name="time" required value="${hm(when)}"></label>
      </div>
      <label class="field"><span>Venue</span><input class="input" name="venue" maxlength="120" placeholder="e.g. Main Auditorium" value="${esc(ev.venue)}"></label>
      <fieldset class="field" style="border:0;margin:0;padding:0"><span>Poster art</span>
        <div class="art-pick">
          ${ART.map((a, i) => `<label><input type="radio" name="art" value="${i}" ${i === ev.art ? "checked" : ""} aria-label="${a.name}"><img src="${artUrl(i, true)}" alt="" loading="lazy" width="240" height="240"><span class="art-name">${a.name}</span></label>`).join("")}
        </div>
      </fieldset>
      <p class="err" id="fErr" role="alert" hidden></p>
      <button class="btn-primary compact" type="submit" id="saveBtn"><span class="label">${id ? "Save changes" : "Create event"}</span><span class="arrow">${I.arrow}</span></button>
    </form>
    </div>`;
  const form = view.querySelector("#evForm"), err = view.querySelector("#fErr");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const name = String(f.get("name")).trim();
    const starts = new Date(`${f.get("date")}T${f.get("time") || "18:00"}`);
    if (!name) { err.textContent = "Give the event a name."; err.hidden = false; return form.name.focus(); }
    if (isNaN(starts)) { err.textContent = "Pick a date and time."; err.hidden = false; return; }
    const row = { name, club: String(f.get("club")).trim(), venue: String(f.get("venue")).trim(), art: Number(f.get("art") || 0), starts_at: starts.toISOString() };
    const btn = view.querySelector("#saveBtn"); btn.disabled = true;
    let data;
    try {
      if (id) {
        await fb.updateEvent(id, row);
        data = { id };
      } else {
        data = { id: await fb.createEvent(row) };
      }
    } catch (e) {
      btn.disabled = false;
      err.textContent = e.message;
      err.hidden = false;
      return;
    }
    btn.disabled = false;
    location.hash = `#/e/${data.id}`;
  });
}

// ─────────────────────────────────────────────── one event

async function eventView(id) {
  view.innerHTML = `<div class="skeleton" style="height:520px"></div>`;
  let ev, passes, gate, claims = [];
  try {
    ev = await fb.getEvent(id);
    if (!ev) { toast("That event isn't yours or was deleted", "x"); location.hash = ""; return; }
    passes = await fb.getPasses(id);
    gate = await fb.joinGate(ev.gate_code);
  } catch (e) { return fail(e); }
  try { claims = await fb.getClaims(ev.gate_code); } catch {}

  passes.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name));
  // Only bounced comes from the staff-writable gate doc; the checked count and
  // per-pass stamps come from immutable claim docs.
  const state = { ev, passes, first: new Map(), bounced: gate?.counts.bounced ?? 0, checked: 0, upload: null, filter: "", shown: 120 };
  for (const claim of claims) if (claim.is_first) state.first.set(claim.pass_id, claim);
  state.checked = state.first.size;

  document.title = `${typo(ev.name)} · GatePass`;
  view.innerHTML = `
    <a class="backlink" href="#">${I.back}Your events</a>
    <div class="dash">
      <div class="left stack">
        <div class="poster" id="poster">
          <h1 class="poster-title ink">${escT(ev.name)}</h1>
          ${ev.club ? `<p class="poster-club">${esc(ev.club)}</p>` : ""}
          <span class="poster-when">${esc(fmtWhen(ev.starts_at))}${ev.venue ? ` · ${esc(ev.venue)}` : ""}</span>
        </div>
        <div id="regSlot" class="stack"></div>
        <div class="stat grain" id="stat"></div>
        <div class="gatebox" id="gatebox"></div>
      </div>
      <div class="right stack">
        <div class="head-row section-gap-m"><h2 class="head">Passes</h2><span class="fine" id="pcount"></span></div>
        <div id="passTools" class="stack"></div>
        <ul class="passlist" id="plist"></ul>
        <div class="more-row" id="more"></div>
        <div class="danger-zone">
          <a class="btn small" href="#/e/${id}/edit">Edit details</a>
          <button class="btn small danger" type="button" id="del">${I.trash}Delete event</button>
        </div>
      </div>
    </div>`;
  view.querySelector("#poster").style.backgroundImage = `url("${artUrl(ev.art)}")`;

  renderReg(state);
  renderStat(state);
  renderGate(state);
  renderPassTools(state);
  renderList(state);

  const del = view.querySelector("#del");
  let armed = 0;
  del.addEventListener("click", async () => {
    if (Date.now() - armed > 4000) { armed = Date.now(); del.innerHTML = `${I.trash}Tap again to delete ${plural(state.passes.length, "pass", "passes")}`; setTimeout(() => { if (del.isConnected) del.innerHTML = `${I.trash}Delete event`; }, 4000); return; }
    del.disabled = true;
    try {
      await fb.deleteEvent(id);
    } catch (e) {
      del.disabled = false;
      return toast(e.message, "x");
    }
    toast("Event deleted");
    location.hash = "";
  });

  startLive(state);
}

// ── registrations: file / paste → preview → generate ──
function renderReg(state) {
  const slot = view.querySelector("#regSlot");
  const has = state.passes.length;
  const up = state.upload;
  if (!up) {
    slot.innerHTML = `
      <label class="row" id="pick">
        <input type="file" id="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" class="sr">
        <span style="width:30px;height:36px;display:block">${I.doc}</span>
        <span class="grow">${has ? "Add more registrations" : "Upload registrations.csv"}<small>Google Form export, or any sheet with a name column</small></span>
        <span class="chev">${I.chev}</span>
      </label>
      <button class="btn small" type="button" id="pasteBtn" style="align-self:flex-start">${I.copy}Or paste rows from your sheet</button>
      <div id="pasteBox" class="stack" hidden>
        <textarea class="textarea" id="pasteTa" placeholder="Copy the cells in Google Sheets (with the header row) and paste here.&#10;Name, Email or Phone, …"></textarea>
        <button class="btn" type="button" id="pasteUse">Use these rows</button>
      </div>`;
    slot.querySelector("#file").addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      if (f.size > 4e6) return toast("That file is over 4 MB. Export just the responses sheet.", "x");
      loadRows(state, await f.text(), f.name);
    });
    slot.querySelector("#pasteBtn").addEventListener("click", () => {
      const box = slot.querySelector("#pasteBox");
      box.hidden = !box.hidden;
      if (!box.hidden) slot.querySelector("#pasteTa").focus();
    });
    slot.querySelector("#pasteUse").addEventListener("click", () => loadRows(state, slot.querySelector("#pasteTa").value, "pasted rows"));
    return;
  }

  const { a, fileName, nameCol, contactCol, open } = up;
  const res = toPasses(a, nameCol, contactCol, state.passes);
  up.res = res;
  const n = res.passes.length;
  const skipped = [res.blank && `${plural(res.blank, "row")} without a name`, res.dup && `${plural(res.dup, "duplicate")}`].filter(Boolean).join(", ");
  const opt = (sel, none) => `${none ? `<option value="-1" ${sel === -1 ? "selected" : ""}>None</option>` : ""}${a.cols.map((c) => `<option value="${c.i}" ${c.i === sel ? "selected" : ""}>${esc(c.label)}</option>`).join("")}`;
  slot.innerHTML = `
    <button class="row" type="button" id="toggle" aria-expanded="${open ? "true" : "false"}">
      <span style="width:30px;height:36px;display:block">${I.doc}</span>
      <span class="grow"><span class="fname">${esc(fileName)} · ${plural(a.body.length, "row")}</span>${skipped ? `<small>${n} new · skipping ${skipped}</small>` : ""}</span>
      <span class="chev" style="transition:rotate .2s;${open ? "rotate:90deg" : ""}">${I.chev}</span>
    </button>
    <div class="upload-preview" ${open ? "" : "hidden"}>
      <div class="two">
        <label class="field"><span>Name column</span><select class="select" id="nameCol">${opt(nameCol)}</select></label>
        <label class="field"><span>Contact column</span><select class="select" id="contactCol">${opt(contactCol, true)}</select></label>
      </div>
      <table class="preview-table">
        <thead><tr><th>Name</th><th>Contact</th></tr></thead>
        <tbody>${res.passes.slice(0, 5).map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.contact || "—")}</td></tr>`).join("") || `<tr><td colspan="2">No usable rows. Pick the column that has names.</td></tr>`}</tbody>
      </table>
      ${n > 5 ? `<p class="fine" style="margin:0">…and ${n - 5} more.</p>` : ""}
      <button class="btn small pinkline" type="button" id="cancelUp" style="align-self:flex-start">${I.x}Cancel</button>
    </div>
    <button class="btn-primary" type="button" id="gen" ${n ? "" : "disabled"}>
      <span class="tix">${I.ticket}</span>
      <span class="label">Generate ${n} ${n === 1 ? "pass" : "passes"}</span>
      <span class="arrow">${I.arrow}</span>
    </button>`;
  slot.querySelector("#toggle").addEventListener("click", () => { up.open = !up.open; renderReg(state); });
  slot.querySelector("#nameCol")?.addEventListener("change", (e) => { up.nameCol = +e.target.value; renderReg(state); });
  slot.querySelector("#contactCol")?.addEventListener("change", (e) => { up.contactCol = +e.target.value; renderReg(state); });
  slot.querySelector("#cancelUp")?.addEventListener("click", () => { state.upload = null; renderReg(state); });
  slot.querySelector("#gen").addEventListener("click", () => generate(state));
}

function loadRows(state, text, fileName) {
  const rows = parseTable(text);
  if (!rows.length) return toast("That sheet is empty", "x");
  const a = analyse(rows);
  if (a.body.length > MAX_ROWS) return toast(`That's ${a.body.length} rows. GatePass takes up to ${MAX_ROWS} at a time.`, "x");
  state.upload = { a, fileName, nameCol: a.name, contactCol: a.contact, open: !a.hasHeader };
  renderReg(state);
}

async function generate(state) {
  const up = state.upload;
  const list = up.res.passes;
  const slot = view.querySelector("#regSlot");
  const total = list.length;
  slot.innerHTML = `
    <div class="row" style="min-height:60px"><span style="width:30px;height:36px;display:block">${I.doc}</span><span class="grow">${esc(up.fileName)} · ${plural(total, "pass", "passes")}</span></div>
    <div class="btn-primary" aria-live="polite" style="cursor:progress">
      <span class="tix">${I.ticket}</span>
      <span class="label"><span class="gen-count" id="gc" style="color:#fff;font-size:inherit">0</span> / ${total} passes<small>Making unguessable links…</small></span>
      <span class="spinner"></span>
    </div>`;
  const gc = slot.querySelector("#gc");
  let done = 0, shown = 0, failed = null;
  const tick = () => {
    if (shown < done) { shown += Math.max(1, Math.ceil((done - shown) / 6)); gc.textContent = Math.min(shown, done); }
    if (shown < total && !failed) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  for (let i = 0; i < total; i += 100) {
    const batch = list.slice(i, i + 100).map((p) => ({ name: p.name, contact: p.contact }));
    try {
      await fb.generatePasses(state.ev.id, batch, { name: state.ev.name, club: state.ev.club, starts_at: state.ev.starts_at, venue: state.ev.venue, art: state.ev.art, gateCode: state.ev.gate_code });
    } catch (e) { failed = e; break; }
    done += batch.length;
  }
  await new Promise((r) => setTimeout(r, 450));
  gc.textContent = done;
  state.upload = null;
  if (failed) toast(`Stopped after ${done}: ${failed.message}`, "x");
  else toast(`${plural(done, "pass", "passes")} ready`);
  try {
    state.passes = await fb.getPasses(state.ev.id);
    state.passes.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name));
  } catch {}
  renderReg(state); renderStat(state); renderPassTools(state); renderList(state);
}

// ── checked-in counter ──
function renderStat(state, bump = false) {
  const total = state.passes.length, checked = state.checked ?? state.first.size;
  const el = view.querySelector("#stat");
  el.innerHTML = `
    <span class="dot">${I.dotCheck}</span>
    <p class="stat-label">Checked in</p>
    <div class="stat-line"><p class="stat-num ink" id="snum">${checked} / ${total}</p><div class="bar" aria-hidden="true"><i style="--p:${total ? Math.min(1, checked / total) : 0}"></i></div></div>
    ${state.bounced ? `<p class="stat-note">${plural(state.bounced, "repeat scan")} bounced at the gate</p>` : ""}`;
  el.setAttribute("aria-label", `Checked in ${checked} of ${total}`);
  if (bump) { const n = el.querySelector("#snum"); n.animate([{ transform: "scale(1.08)", color: "#FF2FA2" }, { transform: "scale(1)" }], { duration: 520, easing: "cubic-bezier(.16,1,.3,1)" }); }
}

// ── gate code ──
function renderGate(state, showQr = false) {
  const ev = state.ev, el = view.querySelector("#gatebox");
  el.innerHTML = `
    <p class="kicker-free">Gate code</p>
    <p class="gate-code ink" aria-label="Gate code ${fmtCode(ev.gate_code).split("").join(" ")}">${fmtCode(ev.gate_code)}</p>
    <p class="fine">Staff open <b>${esc(gateUrl("").replace(/#$/, "").replace(/^https?:\/\//, ""))}</b> and type this. Anyone with the code can scan, so share it only with your team.</p>
    <div class="btns">
      <button class="btn small" type="button" id="cpGate">${I.link}Copy gate link</button>
      <button class="btn small" type="button" id="qrGate" aria-expanded="${showQr}">${I.qr}${showQr ? "Hide QR" : "Show QR"}</button>
      <button class="btn small" type="button" id="rot">${I.refresh}New code</button>
    </div>
    ${showQr ? `<div class="gate-qr">${qrSvg(gateUrl(ev.gate_code), { label: "QR to join the gate" })}<p class="fine" style="color:var(--blue);margin:0">Staff scan this with their phone camera to open the scanner with the code filled in.</p></div>` : ""}`;
  el.querySelector("#cpGate").addEventListener("click", async () => { (await copyText(gateUrl(ev.gate_code))) ? toast("Gate link copied") : toast("Couldn't copy", "x"); });
  el.querySelector("#qrGate").addEventListener("click", () => renderGate(state, !showQr));
  let armed = 0;
  el.querySelector("#rot").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (Date.now() - armed > 4000) { armed = Date.now(); b.innerHTML = `${I.refresh}Tap again: old code stops working`; return; }
    b.disabled = true;
    let data;
    try {
      data = await fb.rotateCode(ev.id, ev.gate_code);
    } catch (e) {
      b.disabled = false;
      return toast(e.message || "Couldn't change the code", "x");
    }
    ev.gate_code = data;
    renderGate(state, showQr);
    startLive(state);
    toast("New gate code. Staff need to re-join.");
  });
}

// ── passes: tools + list ──
function msgFor(state, p) {
  const ev = state.ev;
  const first = p.name.split(" ")[0];
  return `Hi ${first}! Your pass for ${ev.name} (${fmtWhen(ev.starts_at)}${ev.venue ? `, ${ev.venue}` : ""}):\n${passUrl(p.token)}\nShow the QR at the gate. It works once, so don't share it.`;
}
function sendHref(state, p) {
  const c = p.contact || "";
  if (isEmail(c)) return { href: `mailto:${encodeURIComponent(c)}?subject=${encodeURIComponent(`Your pass for ${state.ev.name}`)}&body=${encodeURIComponent(msgFor(state, p))}`, icon: I.mail, label: "Email" };
  if (isPhone(c)) {
    let d = c.replace(/\D/g, "");
    if (d.length === 10) d = "91" + d;          // assume India for bare 10-digit numbers
    if (d.length === 11 && d.startsWith("0")) d = "91" + d.slice(1);
    return { href: `https://wa.me/${d}?text=${encodeURIComponent(msgFor(state, p))}`, icon: I.chat, label: "WhatsApp" };
  }
  return null;
}

function renderPassTools(state) {
  const el = view.querySelector("#passTools");
  view.querySelector("#pcount").textContent = state.passes.length ? plural(state.passes.length, "pass", "passes") : "";
  if (!state.passes.length) {
    el.innerHTML = `<div class="empty"><h3>No passes yet</h3><p class="sub" style="color:var(--blue)">Upload the registrations sheet and each row becomes a pass with its own link.</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="tools">
      <button class="btn small" type="button" id="cpAll">${I.copy}Copy all links</button>
      <button class="btn small" type="button" id="csv">${I.download}Export CSV</button>
    </div>
    <p class="fine" style="margin:0">GatePass sends nothing. Send each link yourself on WhatsApp or email; every link opens that person's pass.</p>
    <div class="search"><span>${I.search}</span><input class="input" id="filter" placeholder="Search names" autocomplete="off" value="${esc(state.filter)}"></div>`;
  el.querySelector("#cpAll").addEventListener("click", async () => {
    const text = state.passes.map((p) => `${p.name}: ${passUrl(p.token)}`).join("\n");
    (await copyText(text)) ? toast(`${plural(state.passes.length, "link")} copied`) : toast("Couldn't copy. Use Export CSV.", "x");
  });
  el.querySelector("#csv").addEventListener("click", () => {
    const rows = [["name", "contact", "pass_link", "checked_in_at", "gate"]].concat(state.passes.map((p) => {
      const s = state.first.get(p.id);
      return [p.name, p.contact, passUrl(p.token), s ? new Date(s.scanned_at).toISOString() : "", s ? s.gate : ""];
    }));
    const slug = state.ev.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event";
    download(`${slug}-passes.csv`, toCsv(rows));
  });
  let t;
  el.querySelector("#filter").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.filter = e.target.value; state.shown = 120; renderList(state); }, 120); });
}

function rowHtml(state, p) {
  const s = state.first.get(p.id);
  const send = sendHref(state, p);
  return `
    <li data-id="${p.id}">
      <p class="pl-name">${esc(p.name)}</p>
      <p class="pl-meta">${s ? `<span class="in">In ${esc(fmtTime(s.scanned_at))} · ${esc(s.gate)}</span> · ` : ""}${esc(p.contact || "no contact")}</p>
      <div class="pl-actions">
        ${send ? `<a class="icon-btn" href="${esc(send.href)}" target="_blank" rel="noopener" aria-label="${send.label} ${esc(p.name)} their pass" title="${send.label}">${send.icon}</a>` : ""}
        <button class="icon-btn" type="button" data-copy="${esc(p.token)}" aria-label="Copy ${esc(p.name)}'s pass link" title="Copy link">${I.copy}</button>
        <a class="icon-btn" href="${esc(passUrl(p.token))}" target="_blank" rel="noopener" aria-label="Open ${esc(p.name)}'s pass" title="Open pass">${I.open}</a>
      </div>
    </li>`;
}

function renderList(state) {
  const ul = view.querySelector("#plist"), more = view.querySelector("#more");
  const f = state.filter.trim().toLowerCase();
  const list = f ? state.passes.filter((p) => p.name.toLowerCase().includes(f) || (p.contact || "").toLowerCase().includes(f)) : state.passes;
  ul.innerHTML = list.slice(0, state.shown).map((p) => rowHtml(state, p)).join("") || (state.passes.length ? `<li><p class="pl-meta">Nobody matches “${esc(state.filter)}”.</p></li>` : "");
  ul.style.borderTop = ul.innerHTML ? "" : "0";
  more.innerHTML = list.length > state.shown ? `<button class="btn small" type="button" id="moreBtn">Show ${Math.min(240, list.length - state.shown)} more of ${list.length - state.shown}</button>` : "";
  more.querySelector("#moreBtn")?.addEventListener("click", () => { state.shown += 240; renderList(state); });
  ul.onclick = async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    (await copyText(passUrl(b.dataset.copy))) ? toast("Pass link copied") : toast("Couldn't copy", "x");
  };
}

// ── live updates ──
function startLive(state) {
  stopLive();
  let refreshing = false, again = false, active = true, lastBounced = state.bounced;
  // The gate doc's `recent` array is writable by any gate-code holder, so never
  // trust it for per-pass stamps. Re-read the authoritative claim docs instead.
  const refresh = async () => {
    if (!active || refreshing) { again = active; return; }   // coalesce bursts without dropping them
    refreshing = true;
    try {
      do {
        again = false;
        const prevChecked = state.checked, prevBounced = state.bounced;
        let claims = [];
        try { claims = await fb.getClaims(state.ev.gate_code); } catch {}
        if (!active) return;   // view was torn down while the fetch was in flight
        state.first = new Map();
        for (const claim of claims) if (claim.is_first) state.first.set(claim.pass_id, claim);
        state.checked = state.first.size;
        state.bounced = lastBounced;
        renderStat(state, state.checked !== prevChecked || state.bounced !== prevBounced);
        renderList(state);
      } while (again);
    } finally {
      refreshing = false;
    }
  };
  const onStats = (e) => {
    const c = e.detail?.counts;
    if (!c || e.detail.badCode) return;
    lastBounced = c.bounced;   // bounced is the only count taken from the gate doc
    refresh();
  };
  window.addEventListener("gp-stats", onStats);
  live = () => { active = false; window.removeEventListener("gp-stats", onStats); fb.stopStats(); };
  fb.gateStats(state.ev.gate_code);
}
function stopLive() { if (live) { live(); live = null; } }

paintIcons();
boot().catch(fail);

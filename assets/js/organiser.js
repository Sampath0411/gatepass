// Organiser app: sign in, events, registrations → passes, links, gate code, live counter.
import {
  configured, ART, artUrl, passUrl, gateUrl, fmtCode, fmtWhen, fmtTime, fmtDay, esc, plural,
  copyText, toast, download, qrSvg, I, paintIcons, DB_MSG, escT, typo, store,
} from "./core.js";
import * as fb from "./firebase.js";
import * as sheets from "./sheets.js";
import { parseTable, analyse, toPasses, toCsv, isEmail, isPhone, normalizePhone, sheetToCsvUrl, fetchSheetCsv } from "./csv.js";
import { passImageBlob, shareOrDownload, copyImageToClipboard, gmailCompose } from "./pass-image.js";

const view = document.getElementById("view");
const roleEl = document.getElementById("role");
let session = null;
let live = null;
let regUnsub = null;          // fest registrations snapshot (Sheet sync + table)
let activeFest = null;        // fest view state, so teardown can stop stale syncs

const MAX_ROWS = 5000;

// Firestore reads/writes can hang forever when the backend is unreachable
// (e.g. Firestore not enabled for the project). Bound every call so the UI
// always shows an error instead of a permanently disabled button or skeleton.
function withTimeout(p, ms = 12000) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => {
      const e = new Error("The database didn't respond. Check your connection and try again.");
      e.code = "deadline-exceeded";
      reject(e);
    }, ms)),
  ]);
}

// Disable a submit button WITH visible feedback while its write is in
// flight. A greyed-out button that still reads "Create event" looks broken
// (live test, 27 Nov 2026); swap its label for a working state and hand
// back a restore function for the error path.
function setBtnBusy(btn, text) {
  if (!btn) return () => {};
  const label = btn.querySelector(".label");
  const orig = label?.textContent;
  btn.disabled = true;
  if (label) label.textContent = text;
  return () => { btn.disabled = false; if (label) label.textContent = orig; };
}

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
      <a class="btn" href="https://github.com/Sampath0411/gatepass" rel="noopener">Read the 5-step guide ${I.open}</a>
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
  // Firestore auto-IDs are 20-character alphanumeric strings, not UUIDs.
  const m = h.match(/^#\/e\/([A-Za-z0-9_-]+)(\/edit)?$/);
  const fm = h.match(/^#\/fest\/([A-Za-z0-9_-]+)$/);
  if (h === "#/new") return v2EventForm();
  if (h === "#/fests") return festListView();
  if (fm) return festView(fm[1]);
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
          <a href="../gate/">${I.qr} Gate staff? Join with a code</a>
          <a href="https://github.com/Sampath0411/gatepass" rel="noopener">${I.open} Host your own copy</a>
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

const artIndexOf = (key) => { const i = ART.findIndex((a) => a.key === key); return i < 0 ? 0 : i; };

async function listView() {
  document.title = "Your events · GatePass";
  view.innerHTML = `<div class="skeleton" style="height:220px"></div>`;
  // ONE event model: the dashboard lists the same gp_events_v2 events the
  // public site creates and shows. Events made with the first dashboard
  // (gp_events) still exist, so they are listed underneath and keep their
  // full toolset — nothing Sam already made is hidden from him.
  let mine, legacy;
  try {
    const idx = await withTimeout(fb.listCreatedEvents(session.uid));
    mine = await Promise.all(idx.map(async (e) => {
      const full = await withTimeout(fb.getV2Event(e.id));
      const gate = full?.gate_code ? await withTimeout(fb.joinGate(full.gate_code)) : null;
      return {
        id: e.id, name: full?.title || e.name, private: (full?.visibility || e.visibility) === "private",
        starts_at: full?.startsAt || e.starts_at, venue: full?.location || "",
        art: artIndexOf(full?.cover),
        total: gate?.counts.total || 0, checked: gate?.counts.checked || 0,
      };
    }));
    const oldIdx = await withTimeout(fb.listEvents(session.uid));
    legacy = await Promise.all(oldIdx.map(async (e) => {
      const full = await withTimeout(fb.getEvent(e.id));
      const gate = full ? await withTimeout(fb.joinGate(full.gate_code)) : null;
      return {
        id: e.id, name: full?.name || e.name, club: full?.club || "",
        starts_at: full?.starts_at || e.starts_at, venue: full?.venue || "",
        art: full?.art || 0,
        total: gate?.counts.total || 0, checked: gate?.counts.checked || 0,
      };
    }));
  } catch (e) { return fail(e); }
  const now = Date.now();
  const stub = (e, extra = "") => {
    const total = e.total ?? 0, checked = e.checked ?? 0;
    const past = new Date(e.starts_at).getTime() < now - 12 * 3600e3;
    return `
      <a class="stub" href="#/e/${e.id}" style="${past ? "opacity:.72" : ""}">
        <span class="stub-art" style="background-image:url('${artUrl(e.art, true)}')"></span>
        <span class="stub-body">
          <span class="stub-name ink">${escT(e.name)}</span>
          <span class="stub-meta">${esc(fmtWhen(e.starts_at))}${e.venue ? ` · ${esc(e.venue)}` : ""}${extra}</span>
        </span>
        <span class="stub-count">${checked} / ${total}<small>${total ? "checked in" : "no passes yet"}</small></span>
      </a>`;
  };
  view.innerHTML = `
    <section class="stack narrow">
      <div class="head-row"><h1 class="head">Your events</h1><a class="btn small" href="#/fests">Fests ${I.arrow}</a></div>
      ${mine.length ? mine.map((e) => stub(e, e.private ? " · Private" : "")).join("") : `
        <div class="empty">
          <h3>No events yet</h3>
          <p class="sub" style="color:var(--blue)">Make one, drop in your registrations sheet, and every row gets a pass. Events you create here are the same events the homepage shows — one list, everywhere.</p>
        </div>`}
      <a class="btn-primary compact" href="#/new" style="margin-top:6px"><span class="tix">${I.ticket}</span><span class="label">New event</span><span class="arrow">${I.arrow}</span></a>
      ${legacy.length ? `
        <h2 class="head" style="margin-top:18px">Earlier events</h2>
        <p class="fine" style="margin:0">Made with the first version of this dashboard. They still work end to end — passes, gate codes and counters included.</p>
        ${legacy.map((e) => stub(e)).join("")}` : ""}
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
      const data = await withTimeout(fb.getEvent(id));
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
    const restoreBtn = setBtnBusy(view.querySelector("#saveBtn"), id ? "Saving…" : "Creating…");
    let data;
    try {
      if (id) {
        await withTimeout(fb.updateEvent(id, row));
        data = { id };
      } else {
        data = { id: await withTimeout(fb.createEvent(row)) };
      }
    } catch (e) {
      restoreBtn();
      err.textContent = e.code === "permission-denied"
        ? "Permission denied. Publish firestore.rules from this project in the Firebase console (see SETUP.md), then try again."
        : e.message;
      err.hidden = false;
      return;
    }
    location.hash = `#/e/${data.id}`;
  });
}

// New events are created in the canonical v2 model — the same events the
// homepage lists and guests RSVP to — so a dashboard event is never a
// second, separate copy. Editing a v2 event happens in the full editor on
// the events site (linked from the event's dashboard page); this quick form
// covers the fields a sheet-driven event needs.
async function v2EventForm() {
  const when = (() => { const d = nextSaturday(); d.setHours(18, 0, 0, 0); return d; })();
  document.title = "New event · GatePass";
  view.innerHTML = `
    <div class="narrow">
    <a class="backlink" href="#">${I.back}Your events</a>
    <form id="evForm" class="stack" novalidate>
      <h1 class="head">New event</h1>
      <label class="field"><span>Event name</span><input class="input" name="name" maxlength="80" required placeholder="e.g. Freshers’ Night 2026"></label>
      <div class="two">
        <label class="field"><span>Date</span><input class="input" type="date" name="date" required value="${ymd(when)}"></label>
        <label class="field"><span>Time</span><input class="input" type="time" name="time" required value="${hm(when)}"></label>
      </div>
      <label class="field"><span>Venue</span><input class="input" name="venue" maxlength="120" placeholder="e.g. Main Auditorium"></label>
      <fieldset class="field" style="border:0;margin:0;padding:0"><span>Poster art</span>
        <div class="art-pick">
          ${ART.map((a, i) => `<label><input type="radio" name="art" value="${i}" ${i === 0 ? "checked" : ""} aria-label="${a.name}"><img src="${artUrl(i, true)}" alt="" loading="lazy" width="240" height="240"><span class="art-name">${a.name}</span></label>`).join("")}
        </div>
      </fieldset>
      <div class="two">
        <label class="field"><span>Visibility</span>
          <select class="select" name="visibility">
            <option value="public" selected>Public — listed on the homepage</option>
            <option value="private">Private — link only</option>
          </select>
        </label>
        <label class="field"><span>Capacity (0 = no limit)</span><input class="input" type="number" name="capacity" min="0" max="100000" value="0"></label>
      </div>
      <p class="err" id="fErr" role="alert" hidden></p>
      <button class="btn-primary compact" type="submit" id="saveBtn"><span class="label">Create event</span><span class="arrow">${I.arrow}</span></button>
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
    const ends = new Date(starts.getTime() + 3 * 3600e3);
    const art = Number(f.get("art") || 0);
    const restoreBtn = setBtnBusy(view.querySelector("#saveBtn"), "Creating…");
    let id;
    try {
      id = await withTimeout(fb.createV2Event({
        title: name, cover: ART[art]?.key || "crowd",
        startsAt: starts.toISOString(), endsAt: ends.toISOString(),
        location: String(f.get("venue")).trim(), description: "", price: "Free",
        approval: false, capacity: Number(f.get("capacity")) || 0,
        visibility: String(f.get("visibility")) === "private" ? "private" : "public",
      }));
    } catch (e2) {
      restoreBtn();
      err.textContent = e2.code === "permission-denied"
        ? "Permission denied. Publish firestore.rules from this project in the Firebase console (see SETUP.md), then try again."
        : e2.message;
      err.hidden = false;
      return;
    }
    location.hash = `#/e/${id}`;
  });
}

// ─────────────────────────────────────────────── fests (Phase A)

const csvSlug = (name) => String(name || "fest").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "fest";

async function festListView() {
  document.title = "Your fests · GatePass";
  view.innerHTML = `<div class="skeleton" style="height:220px"></div>`;
  const here = route.last;
  let fests;
  try { fests = await withTimeout(fb.listFests(session.uid)); }
  catch (e) { return fail(e); }
  if (here !== route.last) return;
  const stubs = fests.map((f) => `
    <a class="stub" href="#/fest/${encodeURIComponent(f.id)}">
      <span class="stub-art" style="background-image:url('${artUrl(0, true)}')"></span>
      <span class="stub-body">
        <span class="stub-name ink">${escT(f.name)}</span>
        <span class="stub-meta">${esc(fmtWhen(f.starts_at))}</span>
      </span>
      <span class="stub-count">Open<small>sub-events &amp; registrations</small></span>
    </a>`).join("");
  view.innerHTML = `
    <section class="stack narrow">
      <div class="head-row"><h1 class="head">Your fests</h1><button class="btn small" type="button" id="newFest">${I.plus}New fest</button></div>
      ${fests.length ? stubs : `
        <div class="empty">
          <h3>No fests yet</h3>
          <p class="sub" style="color:var(--blue)">A fest groups sub-events, their gate codes and one registrations sheet.</p>
        </div>`}
      <p class="fine" style="margin:0">Need a single event with a sheet you upload yourself? <a href="#/new">Make a regular event instead.</a></p>
    </section>`;
  view.querySelector("#newFest").addEventListener("click", festForm);
}

function festForm() {
  document.title = "New fest · GatePass";
  const when = nextSaturday();
  view.innerHTML = `
    <div class="narrow">
      <a class="backlink" href="#/fests">${I.back}Your fests</a>
      <form id="festForm" class="stack" novalidate>
        <h1 class="head">New fest</h1>
        <label class="field"><span>Fest name</span><input class="input" name="name" maxlength="80" required placeholder="e.g. Spring Fest 2026"></label>
        <label class="field"><span>Club</span><input class="input" name="club" maxlength="80" placeholder="e.g. Student Council"></label>
        <label class="field"><span>Venue</span><input class="input" name="venue" maxlength="120" placeholder="e.g. Main Ground"></label>
        <label class="field"><span>Date</span><input class="input" type="date" name="date" required value="${ymd(when)}"></label>
        <p class="err" id="fErr" role="alert" hidden></p>
        <button class="btn-primary compact" type="submit" id="saveFest"><span class="label">Create fest</span><span class="arrow">${I.arrow}</span></button>
      </form>
    </div>`;
  const form = view.querySelector("#festForm"), err = view.querySelector("#fErr");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const name = String(f.get("name")).trim();
    const starts = new Date(`${f.get("date")}T18:00`);
    if (!name) { err.textContent = "Give the fest a name."; err.hidden = false; return form.elements.name.focus(); }
    if (isNaN(starts)) { err.textContent = "Pick a date for the fest."; err.hidden = false; return; }
    const restoreBtn = setBtnBusy(view.querySelector("#saveFest"), "Creating…");
    try {
      const id = await withTimeout(fb.createFest({
        name, club: String(f.get("club")).trim(), venue: String(f.get("venue")).trim(),
        art: 0, starts_at: starts.toISOString(),
      }));
      location.hash = `#/fest/${id}`;
    } catch (e2) {
      restoreBtn();
      err.textContent = e2.message;
      err.hidden = false;
    }
  };
}

async function festView(id) {
  view.innerHTML = `<div class="skeleton" style="height:520px"></div>`;
  const here = route.last;
  let fest, events;
  try {
    fest = await withTimeout(fb.getFest(id));
    if (!fest) { toast("That fest isn't yours or was deleted", "x"); location.hash = "#/fests"; return; }
    events = await withTimeout(fb.listSubEvents(id));
  } catch (e) { return fail(e); }
  if (here !== route.last) return;

  const state = { fest, events, regs: [], syncing: false, syncError: "", alive: true, waSent: new Set(), claimsByEvent: new Map() };
  activeFest = state;
  document.title = `${typo(fest.name)} · GatePass`;
  view.innerHTML = `
    <a class="backlink" href="#/fests">${I.back}Your fests</a>
    <div class="stack">
      <div class="poster" id="festPoster">
        <h1 class="poster-title ink">${escT(fest.name)}</h1>
        ${fest.club ? `<p class="poster-club">${esc(fest.club)}</p>` : ""}
        <span class="poster-when">${esc(fmtWhen(fest.starts_at))}${fest.venue ? ` · ${esc(fest.venue)}` : ""}</span>
      </div>
      <section class="stack" id="festSheetBox"></section>
      <section class="stack" id="festEventsBox"></section>
      <section class="stack" id="festRegsBox"></section>
    </div>`;
  view.querySelector("#festPoster").style.backgroundImage = `url("${artUrl(fest.art)}")`;
  renderFestSheet(state);
  renderFestEvents(state);
  renderFestRegs(state);
  loadFestClaims(state);
  regUnsub = fb.watchRegistrations(fest.id, (rows) => {
    if (!state.alive) return;
    state.regs = rows;
    // WhatsApp "marked sent" markers live on the registration docs, so they
    // survive reloads. Merge additively: a marker written moments ago may
    // still show a pending server timestamp in this snapshot, and a local
    // mark must never flicker back off.
    for (const r of rows) if (r.wa_sent_at) state.waSent.add(r.id);
    renderFestRegs(state);
    loadFestClaims(state);
    syncFestSheet(state);
    // Recount each affected sub-event so its "N passes" and capacity stay
    // accurate. Best-effort: a failed write must never break the live table.
    const ids = [...new Set(rows.map((r) => r.eventId).filter(Boolean))];
    ids.forEach(async (eventId) => {
      try {
        const total = await fb.syncEventTotals(fest.id, eventId);
        if (!state.alive) return;
        const sub = state.events.find((x) => x.id === eventId);
        if (sub && sub.total !== total) {
          sub.total = total;
          renderFestEvents(state);
        }
      } catch { /* totals are advisory; the registrations table still works */ }
    });
  });
}

// Checked-in state for fest sub-events comes from the same one-shot claim
// docs the gate writes. The fest dashboard previously had no view of it at
// all — no per-event counter and no per-person "already in" marker.
async function loadFestClaims(state) {
  await Promise.all(state.events.map(async (e) => {
    try {
      const claims = await fb.getClaims(e.gate_code);
      state.claimsByEvent.set(e.id, new Map(claims.map((c) => [c.pass_id, c])));
    } catch { if (!state.claimsByEvent.has(e.id)) state.claimsByEvent.set(e.id, new Map()); }
  }));
  if (!state.alive) return;
  // Mirror the claims onto the fest pass docs (owner write): a fest pass
  // page reads its "Checked in" stamp from gp_passes, and gate scans can't
  // write it — the same fix as the event dashboard's mirror in startLive.
  if (state.regs.length) {
    const passes = state.regs.filter((r) => r.passId && r.token)
      .map((r) => ({ id: r.passId, token: r.token }));
    const claims = [...state.claimsByEvent.values()]
      .flatMap((m) => [...m.entries()].map(([pass_id, c]) => ({ pass_id, scanned_at: c.scanned_at, gate: c.gate })));
    if (passes.length && claims.length) fb.stampPassesFromClaims(passes, claims).catch(() => {});
  }
  renderFestEvents(state);
  renderFestRegs(state);
}

function festMsg(state, r) {
  const first = (r.name || "").split(" ")[0];
  return `Hi ${first}! Your pass for ${r.eventName || state.fest.name} (${state.fest.name}):\n${passUrl(r.token)}\nShow the QR at the gate. It works once, so don't share it.`;
}

function renderFestSheet(state) {
  const box = view.querySelector("#festSheetBox");
  if (!box) return;
  const f = state.fest;
  const connected = sheets.hasSheetToken();
  box.innerHTML = `
    <div class="head-row"><h2 class="head">Google Sheet</h2><span class="fine">${connected ? "Connected" : "Not connected"}</span></div>
    <p class="fine" style="margin:0">New registrations append here live while this dashboard stays open.</p>
    <label class="field"><span>Sheet URL (or ID)</span><input class="input" id="festSheetUrl" type="url" inputmode="url" placeholder="https://docs.google.com/spreadsheets/d/…/edit" value="${esc(f.sheetId)}"></label>
    <label class="field"><span>Tab / range</span><input class="input" id="festSheetRange" maxlength="120" placeholder="Registrations" value="${esc(f.sheetRange)}"></label>
    <div class="tools">
      <button class="btn small" type="button" id="saveSheet">Save</button>
      <button class="btn small" type="button" id="connectSheet">${I.link}${connected ? "Reconnect" : "Connect Google Sheet"}</button>
    </div>
    <p class="err" id="sheetErr" role="alert" hidden></p>
    <p class="fine" id="syncMsg" style="margin:0"></p>`;
  const err = box.querySelector("#sheetErr");
  box.querySelector("#saveSheet").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    f.sheetId = box.querySelector("#festSheetUrl").value.trim();
    f.sheetRange = box.querySelector("#festSheetRange").value.trim() || "Registrations";
    btn.disabled = true; err.hidden = true;
    try {
      await withTimeout(fb.setFestSheet(f.id, f.sheetId, f.sheetRange));
      renderSyncMsg(state);
      syncFestSheet(state);
      toast("Sheet settings saved");
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
    } finally { btn.disabled = false; }
  });
  box.querySelector("#connectSheet").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; err.hidden = true;
    try {
      await sheets.connectSheet(window.FIREBASE?.googleOAuthClientId || "");
      renderFestSheet(state);
      renderSyncMsg(state);
      syncFestSheet(state);
      toast("Google Sheet connected");
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
    } finally { btn.disabled = false; }
  });
  renderSyncMsg(state);
}

function renderSyncMsg(state) {
  const el = view.querySelector("#syncMsg");
  if (!el) return;
  if (state.syncError) {
    el.innerHTML = `<span class="err">${esc(state.syncError)}</span> <button class="btn small" type="button" id="retrySync">${I.refresh}Retry sync</button>`;
    el.querySelector("#retrySync").onclick = () => syncFestSheet(state);
    return;
  }
  const pending = state.regs.filter((r) => !r.sheet_synced).length;
  el.textContent = !state.fest.sheetId
    ? "Add a Sheet URL above to append registrations automatically."
    : !sheets.hasSheetToken()
      ? "Connect your Google account above to start live Sheet sync."
      : state.syncing ? "Syncing registrations to the Sheet…"
      : pending ? `${plural(pending, "unsynced registration")} waiting — new rows sync as they arrive.`
      : "Sheet is up to date while this dashboard stays open.";
}

// Append every unsynced registration to the fest's Google Sheet. The snapshot
// callback drives this; `syncing` keeps concurrent snapshots from double-writing.
async function syncFestSheet(state) {
  if (state.syncing || !state.alive) return;
  const f = state.fest;
  if (!f.sheetId || !sheets.hasSheetToken()) { renderSyncMsg(state); return; }
  const pending = state.regs.filter((r) => !r.sheet_synced);
  if (!pending.length) { renderSyncMsg(state); return; }
  const seen = new Set(pending.map((r) => r.id));
  const sheetId = sheets.sheetIdFromUrl(f.sheetId);
  if (!sheetId) {
    state.syncError = "That Sheet URL has no spreadsheet ID. Save the full link from your browser's address bar.";
    renderSyncMsg(state);
    return;
  }
  state.syncing = true;
  state.syncError = "";
  renderSyncMsg(state);
  try {
    for (const r of pending) {
      if (!state.alive) return;
      await withTimeout(sheets.appendRows(sheetId, f.sheetRange, [[
        r.created_at || "", f.name, r.eventName || "", r.name || "", r.email || "", r.phone || "", passUrl(r.token),
      ]]), 30000);
      await withTimeout(fb.markSheetSynced(f.id, r.id), 30000);
    }
  } catch (e) {
    state.syncError = `Sheet sync failed: ${e.message || e} Unsynced rows stay in the table — nothing is lost.`;
  } finally {
    state.syncing = false;
    if (state.alive) {
      renderSyncMsg(state);
      // A registration that landed mid-sync was skipped by the guard above.
      if (!state.syncError && state.regs.some((r) => !r.sheet_synced && !seen.has(r.id))) syncFestSheet(state);
    }
  }
}

function renderFestEvents(state) {
  const box = view.querySelector("#festEventsBox");
  if (!box) return;
  const rows = state.events.slice()
    .sort((a, b) => String(a.starts_at || "").localeCompare(String(b.starts_at || "")))
    .map((e) => {
      const link = `../register/#/register/${encodeURIComponent(e.id)}`;
      return `
    <li>
      <p class="pl-name">${escT(e.name)}</p>
      <p class="pl-meta">${esc(fmtWhen(e.starts_at))}${e.venue ? ` · ${esc(e.venue)}` : ""} · Gate code <b>${esc(fmtCode(e.gate_code))}</b> · ${e.registration_open ? "open" : "closed"} · ${plural(e.total || 0, "pass")} · ${state.claimsByEvent.get(e.id)?.size || 0} checked in</p>
      <div class="pl-actions">
        <a class="btn small" href="${esc(link)}" target="_blank" rel="noopener" title="Share this link with students">${I.open}Register link</a>
        <button class="btn small" type="button" data-open="${esc(e.id)}" data-next="${e.registration_open ? "false" : "true"}">${e.registration_open ? "Close registration" : "Open registration"}</button>
      </div>
    </li>`;
    }).join("");
  box.innerHTML = `
    <div class="head-row"><h2 class="head">Sub-events</h2><button class="btn small" type="button" id="addSub">${I.plus}Add sub-event</button></div>
    ${rows ? `<ul class="passlist">${rows}</ul>` : `
      <div class="empty"><h3>No sub-events yet</h3><p class="sub" style="color:var(--blue)">Add one to get a gate code and a public registration link.</p></div>`}
    <form id="subForm" class="stack" hidden novalidate>
      <label class="field"><span>Sub-event name</span><input class="input" name="name" maxlength="80" required placeholder="e.g. Day 1 · Main stage"></label>
      <div class="two">
        <label class="field"><span>Club</span><input class="input" name="club" maxlength="80"></label>
        <label class="field"><span>Venue</span><input class="input" name="venue" maxlength="120"></label>
      </div>
      <div class="two">
        <label class="field"><span>Date</span><input class="input" type="date" name="date" required value="${ymd(nextSaturday())}"></label>
        <label class="field"><span>Time</span><input class="input" type="time" name="time" value="18:00"></label>
      </div>
      <label class="field"><span>Capacity (0 = no limit)</span><input class="input" type="number" name="capacity" min="0" max="100000" value="0"></label>
      <p class="err" id="subErr" role="alert" hidden></p>
      <button class="btn-primary compact" type="submit" id="saveSub"><span class="label">Add sub-event</span><span class="arrow">${I.arrow}</span></button>
    </form>`;
  const form = box.querySelector("#subForm"), subErr = box.querySelector("#subErr");
  box.querySelector("#addSub").onclick = () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.elements.name.focus();
  };
  box.onclick = async (e) => {
    const toggle = e.target.closest("[data-open]");
    if (!toggle) return;
    const subId = toggle.dataset.open, open = toggle.dataset.next === "true";
    toggle.disabled = true;
    try {
      await withTimeout(fb.setRegistrationOpen(state.fest.id, subId, open));
      const sub = state.events.find((x) => x.id === subId);
      if (sub) sub.registration_open = open;
      renderFestEvents(state);
      toast(open ? "Registration opened" : "Registration closed");
    } catch (err) {
      toggle.disabled = false;
      toast(err.message || "Couldn't change registration", "x");
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const name = String(f.get("name")).trim();
    const starts = new Date(`${f.get("date")}T${f.get("time") || "18:00"}`);
    if (!name) { subErr.textContent = "Give the sub-event a name."; subErr.hidden = false; return; }
    if (isNaN(starts)) { subErr.textContent = "Pick a valid date and time."; subErr.hidden = false; return; }
    const btn = box.querySelector("#saveSub"); btn.disabled = true; subErr.hidden = true;
    try {
      const made = await withTimeout(fb.createSubEvent(state.fest.id, {
        name, club: String(f.get("club")).trim(), venue: String(f.get("venue")).trim(),
        art: 0, starts_at: starts.toISOString(), capacity: Number(f.get("capacity")) || 0,
        registration_open: true,
      }));
      state.events = await withTimeout(fb.listSubEvents(state.fest.id));
      renderFestEvents(state);
      toast(`Sub-event added · gate code ${fmtCode(made.code)}`);
    } catch (err) {
      btn.disabled = false;
      subErr.textContent = err.message || "Couldn't add the sub-event";
      subErr.hidden = false;
    }
  };
}

function renderFestRegs(state) {
  const box = view.querySelector("#festRegsBox");
  if (!box) return;
  const rows = state.regs.slice()
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const waRows = rows.filter((r) => isPhone(r.phone || ""));
  const body = rows.map((r) => {
    const claim = state.claimsByEvent?.get(r.eventId)?.get(r.passId);
    const wa = isPhone(r.phone || "") ? normalizePhone(r.phone) : null;
    return `
    <tr>
      <td>${esc(fmtWhen(r.created_at))}</td>
      <td>${escT(r.eventName)}</td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.email || "—")}</td>
      <td>${esc(r.phone || "—")}</td>
      <td><a href="${esc(passUrl(r.token))}" target="_blank" rel="noopener">Open pass</a>${wa ? ` · <a href="https://wa.me/${wa}?text=${encodeURIComponent(festMsg(state, r))}" target="_blank" rel="noopener" data-wa-reg="${esc(r.id)}">WhatsApp</a>` : ""}</td>
      <td>${claim ? `<span class="in">In ${esc(fmtTime(claim.scanned_at))} · ${esc(claim.gate)}</span>` : "—"}</td>
      <td>${r.sheet_synced ? "Synced" : "Pending"}</td>
    </tr>`;
  }).join("");
  box.innerHTML = `
    <div class="head-row"><h2 class="head">All registrations</h2><span class="fine">${plural(rows.length, "registration")}</span></div>
    <div class="tools"><button class="btn small" type="button" id="regsCsv">${I.download}Export CSV</button></div>
    ${rows.length ? `
    <div class="stack" style="gap:8px">
      <p class="fine" style="margin:0"><b>WhatsApp delivery</b> — ${waRows.length} of ${rows.length} registrations have a phone number. Each tap opens one WhatsApp chat with that person's pass already written in — you tap Send. Nothing is sent automatically. Each tap is marked on the pass, so the count survives reloads.</p>
      <div class="btns">
        <button class="btn small" type="button" id="festWaNext">${I.chat}Send next on WhatsApp</button>
        <button class="btn small" type="button" id="festWaCopy">${I.copy}Copy all WhatsApp messages</button>
      </div>
      <p class="fine" id="festWaStatus" style="margin:0"></p>
    </div>
      <table class="preview-table">
        <thead><tr><th>Time</th><th>Sub-event</th><th>Name</th><th>Email</th><th>Phone</th><th>Pass</th><th>Gate</th><th>Sheet</th></tr></thead>
        <tbody>${body}</tbody>
      </table>` : `<p class="fine" style="margin:0">No registrations yet. Share a sub-event's registration link to get started.</p>`}`;
  box.querySelector("#regsCsv").onclick = () => {
    const data = [["created_at", "sub_event", "name", "email", "phone", "pass_url", "checked_in_at", "gate", "sheet_status"]].concat(rows.map((r) => {
      const claim = state.claimsByEvent?.get(r.eventId)?.get(r.passId);
      return [
        r.created_at || "", r.eventName || "", r.name || "", r.email || "", r.phone || "",
        passUrl(r.token), claim ? claim.scanned_at || "" : "", claim ? claim.gate || "" : "",
        r.sheet_synced ? "synced" : "pending",
      ];
    }));
    download(`${csvSlug(state.fest.name)}-registrations.csv`, toCsv(data));
  };
  if (!rows.length) return;
  // Same one-tap-per-chat WhatsApp queue as the single-event dashboard.
  const waStatus = () => {
    const statusEl = box.querySelector("#festWaStatus");
    const nextBtn = box.querySelector("#festWaNext");
    if (!statusEl || !nextBtn) return;
    const done = state.waSent.size, total = waRows.length;
    if (!total) {
      statusEl.textContent = "No registrations have a phone number yet — use Open pass / copy link for those.";
      nextBtn.disabled = true;
      return;
    }
    const next = waRows.find((r) => !state.waSent.has(r.id));
    statusEl.textContent = done >= total
      ? `All ${total} marked as sent. Reopen any row's WhatsApp link to resend one.`
      : `${done} of ${total} marked as sent — next: ${next.name}.`;
    nextBtn.disabled = done >= total;
  };
  // Marking persists waSentAt on the registration doc (fest-owner write), so
  // the count survives reloads; it records the wa.me draft being opened, not
  // delivery — the organiser still taps Send inside WhatsApp.
  const markReg = (r) => {
    if (!r || state.waSent.has(r.id)) return;
    state.waSent.add(r.id);
    r.wa_sent_at = new Date().toISOString();
    waStatus();
    fb.markRegWaSent(state.fest.id, r.id).catch(() => {
      state.waSent.delete(r.id);
      toast("Couldn't save the sent marker — count rolled back", "x");
      waStatus();
    });
  };
  box.querySelector("#festWaNext").onclick = () => {
    const next = waRows.find((r) => !state.waSent.has(r.id));
    if (!next) return waStatus();
    const d = normalizePhone(next.phone);
    if (d) window.open(`https://wa.me/${d}?text=${encodeURIComponent(festMsg(state, next))}`, "_blank", "noopener");
    markReg(next);
  };
  box.querySelectorAll("[data-wa-reg]").forEach((a) => a.addEventListener("click", () => {
    // Let the anchor open the draft first; mark on the next tick.
    const r = state.regs.find((x) => x.id === a.dataset.waReg);
    setTimeout(() => markReg(r), 0);
  }));
  box.querySelector("#festWaCopy").onclick = async () => {
    const text = waRows.map((r) => festMsg(state, r)).join("\n\n");
    (await copyText(text)) ? toast(`${plural(waRows.length, "WhatsApp message")} copied`) : toast("Couldn't copy", "x");
  };
  waStatus();
}

// ─────────────────────────────────────────────── one event

async function eventView(id) {
  view.innerHTML = `<div class="skeleton" style="height:520px"></div>`;
  // Canonical first: an event created on the public site (gp_events_v2) and
  // an event created here are the same event, with the same dashboard.
  // Legacy gp_events from the first dashboard resolve through the fallback.
  let v2 = null;
  try { v2 = await withTimeout(fb.getV2Event(id)); } catch {}
  if (v2 && v2.ownerId === session.uid) {
    let loaded;
    try { loaded = await loadV2State(v2); }
    catch (e) { return fail(e); }
    return eventDashboard(loaded);
  }
  let ev, passes, gate, claims = [];
  try {
    ev = await withTimeout(fb.getEvent(id));
    if (!ev) { toast("That event isn't yours or was deleted", "x"); location.hash = ""; return; }
    passes = await withTimeout(fb.getPasses(id));
    gate = await withTimeout(fb.joinGate(ev.gate_code));
  } catch (e) { return fail(e); }
  try { claims = await fb.getClaims(ev.gate_code); } catch {}
  return eventDashboard({
    kind: "v1", ev, passes, gate, claims,
    canRotate: true, editHref: `#/e/${id}/edit`,
    genBatch: (rows) => fb.generatePasses(id, rows, { name: ev.name, club: ev.club, starts_at: ev.starts_at, venue: ev.venue, art: ev.art, gateCode: ev.gate_code }),
    reloadPasses: () => fb.getPasses(id),
    markWaSent: (p) => fb.markPassWaSent(id, p.id),
    removeEvent: () => fb.deleteEvent(id),
  });
}

// Load a v2 event into the same dashboard state shape the legacy flow uses.
async function loadV2State(v2) {
  const ev = {
    id: v2.id, name: v2.title, club: "", venue: v2.location || "",
    art: artIndexOf(v2.cover), starts_at: v2.startsAt, gate_code: v2.gate_code,
  };
  const passes = await withTimeout(fb.getOrganiserPasses(v2.id));
  const gate = ev.gate_code ? await withTimeout(fb.joinGate(ev.gate_code)) : null;
  let claims = [];
  try { claims = await fb.getClaims(ev.gate_code); } catch {}
  const publicEvent = {
    name: v2.title, title: v2.title, cover: v2.cover, art: ev.art,
    starts_at: v2.startsAt, ends_at: v2.endsAt, location: v2.location || "",
    venue: v2.location || "", description: v2.description || "", price: v2.price || "Free",
  };
  return {
    kind: "v2", ev, passes, gate, claims,
    // Gate-code rotation is not offered for v2 events: the current rules
    // only let a new gate doc be created in the same batch as its event,
    // and existing claims cannot be re-created under a new code — rotating
    // would strand the check-in history and reopen already-scanned passes.
    canRotate: false, editHref: `../#/create/${v2.id}`,
    genBatch: (rows) => fb.generatePassesV2(v2.id, rows, { gateCode: ev.gate_code, publicEvent }),
    reloadPasses: () => fb.getOrganiserPasses(v2.id),
    markWaSent: (p) => fb.markOrganiserPassWaSent(v2.id, p.id),
    removeEvent: async () => {
      const current = await fb.getOrganiserPasses(v2.id);
      await fb.deleteOrganiserPasses(current);
      await fb.deleteV2Event(v2.id);
    },
  };
}

function eventDashboard({ kind, ev, passes, gate, claims, canRotate, editHref, genBatch, reloadPasses, removeEvent, markWaSent }) {
  const id = ev.id;
  // Creation order ONLY: generation stamps each pass 1ms apart precisely so
  // this sort reproduces the sheet's row order. A name tiebreak here used to
  // scramble same-millisecond passes into One, Three, Two.
  passes.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  // Only bounced comes from the staff-writable gate doc; the checked count and
  // per-pass stamps come from immutable claim docs.
  const state = { kind, ev, passes, first: new Map(), bounced: gate?.counts.bounced ?? 0, checked: 0, upload: null, filter: "", shown: 120, waSent: new Set(passes.filter((p) => p.wa_sent_at).map((p) => p.id)), sheet: null, stamped: new Set(), canRotate, editHref, genBatch, reloadPasses, removeEvent, markWaSent };
  // The gate total counts every pass on the gate (RSVPs + sheet-issued);
  // this dashboard's own list may hold only the sheet-issued ones.
  state.total = gate?.counts.total ?? passes.length;
  for (const claim of claims) if (claim.is_first) state.first.set(claim.pass_id, claim);
  state.checked = state.first.size;
  // Remember this event's last synced Sheet link (this browser only).
  state.sheet = store.get(`gp-sheet-${id}`, null);

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
          <a class="btn small" href="${esc(state.editHref)}">Edit details</a>
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
      await withTimeout(state.removeEvent(), 30000);
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
      </div>
      <button class="btn small" type="button" id="sheetBtn" style="align-self:flex-start">${I.refresh}Or sync from a Google Sheet</button>
      <div id="sheetBox" class="stack" hidden>
        <label class="field"><span>Google Sheet link</span><input class="input" id="sheetUrl" type="url" inputmode="url" placeholder="https://docs.google.com/spreadsheets/d/…/edit" value="${esc(state.sheet?.url || "")}"></label>
        <p class="fine" style="margin:0">Live sync, no API key: the sheet must be shared — File → Share → Publish to web, or Anyone with the link can view. Syncing only fetches rows into the same preview below; nothing is generated until you tap Generate, and people already on the list are skipped, never wiped.</p>
        <p class="fine" id="sheetMsg" style="margin:0" ${state.sheet?.lastAt ? "" : "hidden"}>${state.sheet?.lastAt ? `Last synced ${esc(fmtTime(state.sheet.lastAt))} · ${esc(state.sheet.lastNote || "")}` : ""}</p>
        <div class="btns"><button class="btn" type="button" id="sheetSync">Sync sheet</button></div>
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
    slot.querySelector("#sheetBtn").addEventListener("click", () => {
      const box = slot.querySelector("#sheetBox");
      box.hidden = !box.hidden;
      if (!box.hidden) slot.querySelector("#sheetUrl").focus();
    });
    slot.querySelector("#sheetSync").addEventListener("click", () => syncSheet(state));
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

// Google Sheet live sync: fetch the sheet as CSV and land it in the same
// preview as a file upload, so the organiser reviews the columns and taps
// Generate. Duplicates are skipped by toPasses (against the existing list),
// and nothing already generated is touched. No API key, no Apps Script —
// the sheet just has to be published/shared (see the hint under the box).
async function syncSheet(state) {
  const slot = view.querySelector("#regSlot");
  const urlInput = slot.querySelector("#sheetUrl");
  const msg = slot.querySelector("#sheetMsg");
  const btn = slot.querySelector("#sheetSync");
  const raw = urlInput.value.trim();
  const csvUrl = sheetToCsvUrl(raw);
  const showMsg = (text) => { msg.textContent = text; msg.hidden = false; };
  if (!csvUrl) {
    showMsg("That doesn't look like a Google Sheets link. Paste the link from your sheet's address bar.");
    urlInput.focus();
    return;
  }
  btn.disabled = true;
  showMsg("Syncing…");
  try {
    const text = await fetchSheetCsv(csvUrl);
    state.sheet = { url: raw, lastAt: new Date().toISOString(), lastNote: "synced — review the rows, then Generate" };
    store.set(`gp-sheet-${state.ev.id}`, state.sheet);
    loadRows(state, text, "Google Sheet");
    toast("Sheet synced — review the rows, then Generate");
  } catch (e) {
    showMsg(`${e.message} If the fetch keeps failing, publish the sheet (File → Share → Publish to web) or paste the rows instead — the paste box above still works.`);
    toast("Sheet sync failed", "x");
  } finally {
    btn.disabled = false;
  }
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
      await withTimeout(state.genBatch(batch), 30000);
    } catch (e) { failed = e; break; }
    done += batch.length;
  }
  await new Promise((r) => setTimeout(r, 450));
  gc.textContent = done;
  state.upload = null;
  if (failed) toast(`Stopped after ${done}: ${failed.message}`, "x");
  else toast(`${plural(done, "pass", "passes")} ready`);
  try {
    state.passes = await withTimeout(state.reloadPasses());
    // Creation order only (stable sort keeps the stored order on ties) —
    // never a name tiebreak: that scrambled a fresh batch into One, Three, Two.
    state.passes.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    // Newly generated passes start unmarked; keep any markers already stored.
    state.waSent = new Set(state.passes.filter((p) => p.wa_sent_at).map((p) => p.id));
    const gate = await withTimeout(fb.joinGate(state.ev.gate_code));
    if (gate) state.total = gate.counts.total;
  } catch {}
  renderReg(state); renderStat(state); renderPassTools(state); renderList(state);
}

// ── checked-in counter ──
function renderStat(state, bump = false) {
  const total = state.total ?? state.passes.length, checked = state.checked ?? state.first.size;
  const el = view.querySelector("#stat");
  el.innerHTML = `
    <span class="dot">${I.dotCheck}</span>
    <p class="stat-label">Checked in</p>
    <div class="stat-line"><p class="stat-num ink" id="snum">${checked} / ${total}</p><div class="bar" aria-hidden="true"><i style="--p:${total ? Math.min(1, checked / total) : 0}"></i></div></div>
    ${state.bounced ? `<p class="stat-note">${plural(state.bounced, "repeat scan")} bounced at the gate</p>` : ""}`;
  el.setAttribute("aria-label", `Checked in ${checked} of ${total}`);
  if (bump) { const n = el.querySelector("#snum"); n.animate([{ transform: "scale(1.08)", color: "#D4107F" }, { transform: "scale(1)" }], { duration: 520, easing: "cubic-bezier(.16,1,.3,1)" }); }
}

// ── gate code ──
function renderGate(state, showQr = false) {
  const ev = state.ev, el = view.querySelector("#gatebox");
  el.innerHTML = `
    <p class="kicker-free">Gate code</p>
    <p class="gate-code ink" aria-label="Gate code ${fmtCode(ev.gate_code).split("").join(" ")}">${fmtCode(ev.gate_code)}</p>
    <p class="fine">Staff open&nbsp;<b>${esc(gateUrl("").replace(/#$/, "").replace(/^https?:\/\//, ""))}</b>&nbsp;and type this. Anyone with the code can scan, so share it only with your team.</p>
    <div class="btns">
      <button class="btn small" type="button" id="cpGate">${I.link}Copy gate link</button>
      <button class="btn small" type="button" id="qrGate" aria-expanded="${showQr}">${I.qr}${showQr ? "Hide QR" : "Show QR"}</button>
      ${state.canRotate ? `<button class="btn small" type="button" id="rot">${I.refresh}New code</button>` : ""}
    </div>
    ${showQr ? `<div class="gate-qr">${qrSvg(gateUrl(ev.gate_code), { fg: "#1A43B4", label: "QR to join the gate" })}<p class="fine" style="color:var(--blue);margin:0">Staff scan this with their phone camera to open the scanner with the code filled in.</p></div>` : ""}`;
  el.querySelector("#cpGate").addEventListener("click", async () => { (await copyText(gateUrl(ev.gate_code))) ? toast("Gate link copied") : toast("Couldn't copy", "x"); });
  el.querySelector("#qrGate").addEventListener("click", () => renderGate(state, !showQr));
  let armed = 0;
  el.querySelector("#rot")?.addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (Date.now() - armed > 4000) { armed = Date.now(); b.innerHTML = `${I.refresh}Tap again: old code stops working`; return; }
    b.disabled = true;
    let data;
    try {
      data = await withTimeout(fb.rotateCode(ev.id, ev.gate_code), 30000);
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
  if (isEmail(c)) return { email: c, icon: I.mail, label: "Email" };
  if (isPhone(c)) {
    const d = normalizePhone(c);               // assume India for bare 10-digit numbers
    if (!d) return null;
    return { href: `https://wa.me/${d}?text=${encodeURIComponent(msgFor(state, p))}`, icon: I.chat, label: "WhatsApp" };
  }
  return null;
}
// Passes with a phone number (WhatsApp) vs passes with no phone at all.
function waPasses(state) {
  return state.passes.filter((p) => isPhone(p.contact || ""));
}

// Record a WhatsApp tap on the pass itself (waSentAt, via state.markWaSent)
// so the "marked sent" count is honest and survives reloads — it used to be
// a session-only Set that reset on every reload. Optimistic in the UI; if
// the write fails, the marker rolls back and the organiser hears about it.
// The marker means "the wa.me draft was opened": the organiser still taps
// Send inside WhatsApp, and GatePass never claims delivery.
function noteWaSent(state, p, refresh) {
  if (!p || state.waSent.has(p.id)) { refresh?.(); return; }
  state.waSent.add(p.id);
  const prev = p.wa_sent_at;
  p.wa_sent_at = new Date().toISOString();
  refresh?.();
  Promise.resolve(state.markWaSent?.(p)).catch(() => {
    state.waSent.delete(p.id);
    p.wa_sent_at = prev;
    refresh?.();
    toast("Couldn't save the sent marker — count rolled back", "x");
  });
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
    <p class="fine" style="margin:0">GatePass sends nothing itself. Send each link yourself on WhatsApp or email; every link opens that person's pass.</p>
    <div class="stack" id="waBox" style="gap:8px">
      <p class="fine" style="margin:0"><b>WhatsApp delivery</b> — ${waPasses(state).length} of ${state.passes.length} passes have a phone number${state.passes.length - waPasses(state).length ? `; ${state.passes.length - waPasses(state).length} have no phone — use Email or Copy link for those` : ""}. Each tap opens one WhatsApp chat with that person's pass already written in — you tap Send. Nothing is sent automatically. Each tap is marked on the pass, so the count survives reloads.</p>
      <div class="btns">
        <button class="btn small" type="button" id="waNext">${I.chat}Send next on WhatsApp</button>
        <button class="btn small" type="button" id="waCopyAll">${I.copy}Copy all WhatsApp messages</button>
      </div>
      <p class="fine" id="waStatus" style="margin:0">${state.waSent.size ? `${state.waSent.size} marked as sent` : "Not started yet — the first tap opens the first phone number on the list."}</p>
    </div>
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
  // WhatsApp delivery queue: one tap opens one chat (a real user gesture, so
  // the browser won't block it). Each tap is marked on the pass itself
  // (waSentAt), so the count survives reloads; "marked as sent" means the
  // draft was opened — GatePass never sends a message by itself.
  const waStatus = () => {
    const done = state.waSent.size, total = waPasses(state).length;
    const statusEl = el.querySelector("#waStatus");
    const nextBtn = el.querySelector("#waNext");
    if (!total) {
      statusEl.textContent = "No passes have a phone number yet — add a phone column when you upload, or use Email / Copy link for those rows.";
      nextBtn.disabled = true;
      return;
    }
    const next = waPasses(state).find((p) => !state.waSent.has(p.id) && sendHref(state, p)?.href);
    statusEl.textContent = done >= total
      ? `All ${total} marked as sent. Reopen any row's WhatsApp button to resend one.`
      : next
        ? `${done} of ${total} marked as sent — next: ${next.name}.`
        : `${done} of ${total} marked as sent — the rest have numbers WhatsApp can't open; use Email or Copy link for those.`;
    nextBtn.disabled = !next;
  };
  state.refreshWa = waStatus;
  el.querySelector("#waNext").addEventListener("click", () => {
    const next = waPasses(state).find((p) => !state.waSent.has(p.id) && sendHref(state, p)?.href);
    if (!next) return waStatus();
    window.open(sendHref(state, next).href, "_blank", "noopener");
    noteWaSent(state, next, waStatus);
  });
  el.querySelector("#waCopyAll").addEventListener("click", async () => {
    const text = waPasses(state).map((p) => msgFor(state, p)).join("\n\n");
    (await copyText(text)) ? toast(`${plural(waPasses(state).length, "WhatsApp message")} copied`) : toast("Couldn't copy", "x");
  });
  waStatus();
  let t;
  el.querySelector("#filter").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.filter = e.target.value; state.shown = 120; renderList(state); }, 120); });
}

function rowHtml(state, p) {
  const s = state.first.get(p.id);
  const send = sendHref(state, p);
  return `
    <li data-id="${p.id}">
      <p class="pl-name">${esc(p.name)}</p>
      <p class="pl-meta">${s ? `<span class="in">In ${esc(fmtTime(s.scanned_at))} · ${esc(s.gate)}</span> · ` : ""}${esc(p.contact || "no contact")}${state.waSent.has(p.id) ? ` · WhatsApp marked sent` : ""}</p>
      <div class="pl-actions">
        ${send ? (send.email
          ? `<button class="icon-btn" type="button" data-email="${esc(p.token)}" aria-label="Email ${esc(p.name)} their pass photo" title="Email pass photo">${send.icon}</button>`
          : `<a class="icon-btn" href="${esc(send.href)}" target="_blank" rel="noopener" data-wa="${esc(p.id)}" aria-label="${send.label} ${esc(p.name)} their pass" title="${send.label}">${send.icon}</a>`) : ""}
        <button class="icon-btn" type="button" data-image="${esc(p.token)}" aria-label="Share ${esc(p.name)}'s pass photo" title="Share pass photo">${I.image}</button>
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
    const wa = e.target.closest("[data-wa]");
    if (wa) {
      // Don't preventDefault: the anchor still opens the WhatsApp draft.
      // Mark the pass as sent (persisted), then refresh the row + counter
      // after the click's default action has had its turn.
      const p = state.passes.find((x) => x.id === wa.dataset.wa);
      if (p) setTimeout(() => noteWaSent(state, p, () => { state.refreshWa?.(); renderList(state); }), 0);
    }
    const mail = e.target.closest("[data-email]");
    if (mail) {
      const p = state.passes.find((x) => x.token === mail.dataset.email);
      if (!p) return;
      const info = sendHref(state, p);
      if (!info?.email) return;
      mail.disabled = true;
      const popup = window.open("", "_blank");
      if (popup) popup.opener = null;
      const openGmail = (to, subject, body) => {
        const url = gmailCompose(to, subject, body);
        if (popup && !popup.closed) popup.location.href = url;
        else window.open(url, "_blank", "noopener");
      };
      try {
        const s = state.first.get(p.id);
        const blob = await passImageBlob({
          name: p.name,
          event: { name: state.ev.name, club: state.ev.club, starts_at: state.ev.starts_at, venue: state.ev.venue, art: state.ev.art },
          checked_in_at: s?.scanned_at, gate: s?.gate,
        }, p.token);
        const filename = `gatepass-${p.name.replace(/[^A-Za-z0-9]+/g, "-")}.png`;
        const copied = await copyImageToClipboard(blob);
        if (copied) {
          openGmail(info.email, `Your pass for ${state.ev.name}`,
            `Hi ${p.name.split(" ")[0]}!\n\nYour pass photo is copied to your clipboard — paste it here (Ctrl+V, or long-press and Paste) to include it.\n\n${passUrl(p.token)}`);
          toast("Pass photo copied — paste it into the email", "check");
        } else {
          const shared = await shareOrDownload(blob, filename, `${p.name}'s GatePass for ${state.ev.name}`);
          if (shared !== "shared") {
            openGmail(info.email, `Your pass for ${state.ev.name}`,
              `${msgFor(state, p)}\n\nThe pass photo was downloaded — please attach it to this email.`);
          }
          if (shared === "shared" && popup && !popup.closed) popup.close();
          toast(shared === "shared" ? "Pass photo shared" : "Pass photo downloaded — attach it in Gmail");
        }
      } catch (err) { toast("Couldn't make the pass photo: " + err.message, "x"); }
      finally { mail.disabled = false; }
      return;
    }
    const img = e.target.closest("[data-image]");
    if (img) {
      const p = state.passes.find((x) => x.token === img.dataset.image);
      if (!p) return;
      img.disabled = true;
      try {
        const s = state.first.get(p.id);
        const blob = await passImageBlob({
          name: p.name,
          event: { name: state.ev.name, club: state.ev.club, starts_at: state.ev.starts_at, venue: state.ev.venue, art: state.ev.art },
          checked_in_at: s?.scanned_at, gate: s?.gate,
        }, p.token);
        const result = await shareOrDownload(blob, `gatepass-${p.name.replace(/[^A-Za-z0-9]+/g, "-")}.png`, `${p.name}'s GatePass for ${state.ev.name}`);
        toast(result === "shared" ? "Pass photo shared" : result === "cancelled" ? "Share cancelled" : "Pass photo downloaded");
      } catch (err) { toast("Couldn't make the pass photo: " + err.message, "x"); }
      finally { img.disabled = false; }
      return;
    }
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
        // Mirror new claims onto the pass docs (an owner-only write) so the
        // pass pages show "Checked in" under the hardened rules, where gate
        // scans no longer stamp the pass doc themselves. This must run for
        // BOTH event kinds: v2 passes previously "relied on" the gate's
        // best-effort stamp, but gate staff are signed out and the rules
        // deny that write — so a scanned v2 pass page NEVER updated (live
        // test, 27 Nov 2026). The claim stays the only scan authority; this
        // is purely its attendee-visible mirror. (For v2 the write needs
        // the stamp grant in firestore.rules — see the gp_passes match.)
        const fresh = claims.filter((c) => c.is_first && !state.stamped.has(c.pass_id));
        if (fresh.length) {
          fb.stampPassesFromClaims(state.passes, fresh)
            .then(() => fresh.forEach((c) => state.stamped.add(c.pass_id)))
            .catch(() => {});
        }
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
function stopLive() {
  if (live) { live(); live = null; }
  if (regUnsub) { regUnsub(); regUnsub = null; }
  if (activeFest) { activeFest.alive = false; activeFest = null; }
}

paintIcons();
boot().catch(fail);

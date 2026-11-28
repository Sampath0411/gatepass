// Organiser app: sign in, events, registrations → passes, links, gate code, live counter.
import {
  configured, ART, artUrl, passUrl, gateUrl, fmtCode, fmtWhen, fmtTime, fmtDay, esc, plural,
  copyText, toast, download, qrSvg, I, paintIcons, DB_MSG, escT, typo, store, wireThemeToggles,
} from "./core.js";
import * as fb from "./firebase.js";
import * as sheets from "./sheets.js";
import { parseTable, analyse, toPasses, toCsv, isEmail, isPhone, normalizePhone, sheetToCsvUrl, fetchSheetCsv } from "./csv.js";
import { passImageBlob, shareOrDownload, copyImageToClipboard, gmailCompose } from "./pass-image.js";
import { parsePricePaise, formatPaise } from "./payments.js";

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
  const m = h.match(/^#\/e\/([A-Za-z0-9_-]+)(\/edit|\/report)?$/);
  const fm = h.match(/^#\/fest\/([A-Za-z0-9_-]+)$/);
  const nm = h.match(/^#\/new(?:\?from=([A-Za-z0-9_-]+))?$/);
  if (nm) return v2EventForm(nm[1] || null);
  if (h === "#/fests") return festListView();
  if (fm) return festView(fm[1]);
  if (m) return m[2] === "/edit" ? eventForm(m[1]) : m[2] === "/report" ? reportView(m[1]) : eventView(m[1]);
  return listView();
}

function fail(e) {
  const msg = e?.message || String(e);
  const signature = `${e?.code || ""} ${msg}`;
  const paused = /unavailable|deadline-exceeded|network|fetch|5\d\d/.test(signature) ? DB_MSG + " Or check your connection." : msg;
  // No inline onclick: the site's CSP (vercel.json) has no 'unsafe-inline'
  // for scripts, so an inline handler would be a dead button in production.
  view.innerHTML = `<section class="empty"><h3>Something broke</h3><p class="sub">${esc(paused)}</p><p style="margin-top:14px"><button class="btn small" type="button" id="failRetry">${I.refresh}Try again</button></p></section>`;
  view.querySelector("#failRetry")?.addEventListener("click", () => location.reload());
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
// The create form doubles as the Duplicate flow: with ?from=<id> it
// prefills from that v2 event (name, venue, art, visibility, capacity)
// and carries the fields the quick form doesn't show (description, price,
// approval, timezone, form fields) over at submit time. Only details and
// settings are copied — createV2Event always mints a fresh gate code and
// the new event starts with zero passes, RSVPs and claims. The default
// date is the source's weekday and time, one week on, rolled forward by
// whole weeks until it is in the future; the organiser confirms or
// changes it in the date field like any other create.
async function v2EventForm(sourceId = null) {
  let src = null;
  if (sourceId) {
    view.innerHTML = `<div class="skeleton" style="height:220px"></div>`;
    try {
      const v = await withTimeout(fb.getV2Event(sourceId));
      if (v && v.ownerId === session.uid) src = v;
    } catch {}
    if (!src) toast("Couldn't load that event to duplicate — starting blank", "x");
  }
  const when = (() => {
    if (src?.startsAt) {
      const d = new Date(src.startsAt);
      if (!isNaN(d)) {
        d.setDate(d.getDate() + 7);
        while (d.getTime() <= Date.now()) d.setDate(d.getDate() + 7);
        return d;
      }
    }
    const d = nextSaturday(); d.setHours(18, 0, 0, 0); return d;
  })();
  const duration = src?.startsAt && src?.endsAt
    ? new Date(src.endsAt).getTime() - new Date(src.startsAt).getTime() : 0;
  document.title = `${src ? "Duplicate" : "New"} event · GatePass`;
  view.innerHTML = `
    <div class="narrow">
    <a class="backlink" href="#">${I.back}Your events</a>
    <form id="evForm" class="stack" novalidate>
      <h1 class="head">${src ? "Duplicate event" : "New event"}</h1>
      ${src ? `<p class="fine" style="margin:0">Copying <b>${escT(src.title)}</b> — details and settings only. Passes, RSVPs and check-ins are not copied, and the copy gets its own gate code. Check the date, then create.</p>` : ""}
      <label class="field"><span>Event name</span><input class="input" name="name" maxlength="80" required placeholder="e.g. Freshers’ Night 2026" value="${esc(src?.title || "")}"></label>
      <div class="two">
        <label class="field"><span>Date</span><input class="input" type="date" name="date" required value="${ymd(when)}"></label>
        <label class="field"><span>Time</span><input class="input" type="time" name="time" required value="${hm(when)}"></label>
      </div>
      <label class="field"><span>Venue</span><input class="input" name="venue" maxlength="120" placeholder="e.g. Main Auditorium" value="${esc(src?.location || "")}"></label>
      <fieldset class="field" style="border:0;margin:0;padding:0"><span>Poster art</span>
        <div class="art-pick">
          ${ART.map((a, i) => `<label><input type="radio" name="art" value="${i}" ${i === (src ? artIndexOf(src.cover) : 0) ? "checked" : ""} aria-label="${a.name}"><img src="${artUrl(i, true)}" alt="" loading="lazy" width="240" height="240"><span class="art-name">${a.name}</span></label>`).join("")}
        </div>
      </fieldset>
      <div class="two">
        <label class="field"><span>Visibility</span>
          <select class="select" name="visibility">
            <option value="public" ${src?.visibility !== "private" ? "selected" : ""}>Public — listed on the homepage</option>
            <option value="private" ${src?.visibility === "private" ? "selected" : ""}>Private — link only</option>
          </select>
        </label>
        <label class="field"><span>Capacity (0 = no limit)</span><input class="input" type="number" name="capacity" min="0" max="100000" value="${src?.capacity || 0}"></label>
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
    const ends = new Date(starts.getTime() + (duration > 0 ? duration : 3 * 3600e3));
    const art = Number(f.get("art") || 0);
    const restoreBtn = setBtnBusy(view.querySelector("#saveBtn"), "Creating…");
    let id;
    try {
      id = await withTimeout(fb.createV2Event({
        title: name, cover: ART[art]?.key || "crowd",
        startsAt: starts.toISOString(), endsAt: ends.toISOString(),
        location: String(f.get("venue")).trim(),
        description: src?.description || "", price: src?.price || "Free",
        approval: !!src?.approval, capacity: Number(f.get("capacity")) || 0,
        visibility: String(f.get("visibility")) === "private" ? "private" : "public",
        timezone: src?.timezone || "", formFields: src?.formFields,
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
    if (passes.length && claims.length) {
      fb.stampPassesFromClaims(passes, claims)
        .catch((e) => surfaceStampError("fest stamp mirror", e));
    }
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

// The dashboard's ONE pass list for a v2 event: organiser-issued passes
// (sheet/paste import) PLUS every RSVP-issued pass (Google and guest),
// each tagged with its source. The gate doc's counters and the claim docs
// already cover both universes — a dashboard that listed only the
// sheet-issued ones showed three different totals on one screen and hid
// the RSVP passes from the organiser entirely (live test, 27 Nov 2026).
async function loadUnifiedPasses(eventId) {
  const own = await withTimeout(fb.getOrganiserPasses(eventId));
  // The RSVP half reads a different collection under different rules
  // grants than the organiser half. If it is denied (e.g. the published
  // rules lag the repo's), the dashboard must degrade LOUDLY — organiser
  // passes on screen plus a visible incompleteness hint — never silently
  // organiser-only (which reads as "the RSVP passes vanished") and never
  // a dead dashboard. The error rides on the returned array so every
  // caller (initial load, reload after generating) can surface it.
  let rsvp = [], rsvpError = "";
  try {
    rsvp = await withTimeout(fb.getRsvpPasses(eventId));
  } catch (e) {
    console.error("[GatePass] RSVP pass load failed:", e);
    rsvpError = "RSVP and guest passes couldn't be loaded — the list below is incomplete. If this keeps showing, the Firestore rules on the Firebase project are out of date — re-publish firestore.rules from the repo.";
  }
  const merged = [...own.map((p) => ({ ...p, source: "organiser" })), ...rsvp];
  merged.rsvpError = rsvpError;
  return merged;
}

// Load a v2 event into the same dashboard state shape the legacy flow uses.
async function loadV2State(v2) {
  const ev = {
    id: v2.id, name: v2.title, club: "", venue: v2.location || "",
    art: artIndexOf(v2.cover), starts_at: v2.startsAt, gate_code: v2.gate_code,
  };
  // A dashboard open is a waitlist promotion moment: spots may have
  // freed since the last visit (a member cancelled from their own page
  // — which cannot promote anyone itself — or capacity was raised from
  // the edit form). The queue drains BEFORE the pass list is built, so
  // promoted members appear below as ordinary passes and the gate-total
  // reconcile counts them. Failures surface like the other load
  // problems instead of failing the whole dashboard.
  let promotedCount = 0, waitlistError = "";
  try {
    const res = await withTimeout(fb.promoteWaitlist(v2.id));
    promotedCount = res?.promoted?.length || 0;
  } catch (e) {
    console.error("[GatePass] waitlist promotion failed:", e);
    waitlistError = "The waitlist couldn't be checked — queued guests may not have been promoted. If this keeps showing, the Firestore rules on the Firebase project are out of date — re-publish firestore.rules from the repo.";
  }
  const passes = await loadUnifiedPasses(v2.id);
  let waitlist = [];
  try { waitlist = await withTimeout(fb.listWaitlist(v2.id)); }
  catch (e) { console.error("[GatePass] waitlist load failed:", e); }
  const gate = ev.gate_code ? await withTimeout(fb.joinGate(ev.gate_code)) : null;
  // Reconcile the gate doc's total with the unified list: the list IS
  // the issued-pass count, and the gate scanner reads the doc — a doc
  // drifted by an older build (live test event: gate said 4, five
  // passes existed) would otherwise disagree with this dashboard
  // forever. Only heal from a COMPLETE list: with the RSVP half missing
  // the count is a lower bound, and writing it would clobber the truth.
  let totalError = "";
  if (gate && !passes.rsvpError && gate.counts.total !== passes.length) {
    try {
      await withTimeout(fb.repairGateTotal(ev.gate_code, passes.length));
      gate.counts.total = passes.length;
    } catch (e) {
      console.error("[GatePass] gate total reconcile failed:", e);
      totalError = "The gate scanner's total couldn't be reconciled with the pass list — the scanner may show a different total until this is fixed. If this keeps showing, the Firestore rules on the Firebase project are out of date — re-publish firestore.rules from the repo.";
    }
  }
  let claims = [];
  try { claims = await fb.getClaims(ev.gate_code); } catch {}
  // Paid events: the Payments section reads the order fields off the
  // RSVP docs (the owner already reads them all for the pass list).
  // Free events skip the read entirely — no section, no extra fetch.
  let payments = null;
  const amountPaise = parsePricePaise(v2.price);
  if (amountPaise > 0) {
    let orders = [];
    try {
      const all = await withTimeout(fb.listRsvps(v2.id));
      orders = all.filter((r) => r.pay_status || r.amount_paise);
    } catch (e) { console.error("[GatePass] payments load failed:", e); }
    payments = { amountPaise, orders };
  }
  const publicEvent = {
    name: v2.title, title: v2.title, cover: v2.cover, art: ev.art,
    starts_at: v2.startsAt, ends_at: v2.endsAt, location: v2.location || "",
    venue: v2.location || "", description: v2.description || "", price: v2.price || "Free",
  };
  return {
    kind: "v2", ev, passes, gate, claims, unified: true,
    rsvpError: passes.rsvpError || "", totalError,
    capacity: v2.capacity || 0, waitlist, promotedCount, waitlistError, payments,
    reloadWaitlist: () => fb.listWaitlist(v2.id),
    // Removing a queued member is a rejection without a pass to revoke:
    // rejectMember flips the status (and re-drains the queue, which
    // re-stamps the remaining positions).
    removeFromWaitlist: (uid) => fb.rejectMember(v2.id, uid),
    // Gate-code rotation is not offered for v2 events: the current rules
    // only let a new gate doc be created in the same batch as its event,
    // and existing claims cannot be re-created under a new code — rotating
    // would strand the check-in history and reopen already-scanned passes.
    canRotate: false, editHref: `../#/create/${v2.id}`,
    genBatch: (rows) => fb.generatePassesV2(v2.id, rows, { gateCode: ev.gate_code, publicEvent }),
    reloadPasses: () => loadUnifiedPasses(v2.id),
    // The sent marker lives in a different store per universe: the owner's
    // index-doc array for sheet-issued passes, the RSVP doc for RSVP ones.
    markWaSent: (p) => p.source === "organiser"
      ? fb.markOrganiserPassWaSent(v2.id, p.id)
      : fb.markRsvpWaSent(v2.id, p.id),
    // The reminder marker dispatches exactly like the delivery marker:
    // index-doc array entry for sheet-issued passes, RSVP doc field for
    // RSVP ones.
    markReminded: (p) => p.source === "organiser"
      ? fb.markOrganiserPassReminded(v2.id, p.id)
      : fb.markRsvpReminded(v2.id, p.id),
    removeEvent: async () => {
      const current = await fb.getOrganiserPasses(v2.id);
      await fb.deleteOrganiserPasses(current);
      await fb.deleteV2Event(v2.id);
    },
  };
}

function eventDashboard({ kind, ev, passes, gate, claims, canRotate, editHref, genBatch, reloadPasses, removeEvent, markWaSent, markReminded, unified = false, rsvpError = "", totalError = "", capacity = 0, waitlist = [], reloadWaitlist = null, removeFromWaitlist = null, promotedCount = 0, waitlistError = "", payments = null }) {
  const id = ev.id;
  // Creation order ONLY: generation stamps each pass 1ms apart precisely so
  // this sort reproduces the sheet's row order. A name tiebreak here used to
  // scramble same-millisecond passes into One, Three, Two.
  passes.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  // Only bounced comes from the staff-writable gate doc; the checked count and
  // per-pass stamps come from immutable claim docs.
  const state = { kind, ev, passes, claims, first: new Map(), bounced: gate?.counts.bounced ?? 0, checked: 0, upload: null, filter: "", shown: 120, waSent: new Set(passes.filter((p) => p.wa_sent_at).map((p) => p.id)), reminded: new Set(passes.filter((p) => p.reminded_at).map((p) => p.id)), sheet: null, stamped: new Set(), canRotate, editHref, genBatch, reloadPasses, removeEvent, markWaSent, markReminded, unified, rsvpError, totalError, capacity, waitlist, reloadWaitlist, removeFromWaitlist, waitlistError, payments };
  // Unified (v2) dashboards list every pass there is — sheet-issued and
  // RSVP-issued — so the list length IS the total, the same number the
  // gate doc counts and the scanner shows. Legacy dashboards keep reading
  // the gate doc's total.
  state.total = unified ? passes.length : (gate?.counts.total ?? passes.length);
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
        <div id="waitlistSlot"></div>
        <div id="paySlot"></div>
        <div class="danger-zone">
          <a class="btn small" href="${esc(state.editHref)}">Edit details</a>
          ${state.unified ? `<a class="btn small" href="#/e/${encodeURIComponent(id)}/report">Report</a>` : ""}
          ${state.unified ? `<a class="btn small" href="#/new?from=${encodeURIComponent(id)}">${I.copy}Duplicate</a>` : ""}
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
  renderWaitlist(state);
  renderPayments(state);
  if (promotedCount) toast(`${plural(promotedCount, "waitlisted guest")} promoted from the waitlist`, "check");

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
      e.target.value = "";   // let the same file be re-picked after an error
      if (!f) return;
      if (f.size > 4e6) return toast("That file is over 4 MB. Export just the responses sheet.", "x");
      // The accept attribute is only a file-picker hint — enforce the sheet
      // types here, and never let a binary file (photo, PDF, archive) reach
      // the CSV parser as garbage rows. Name/extension is checked because
      // the OS-supplied MIME type for .csv is unreliable across platforms.
      if (!/\.(csv|tsv|txt)$/i.test(f.name || "")) {
        return toast("That file isn't a .csv, .tsv or .txt sheet. Export the responses as CSV and upload that.", "x");
      }
      let text;
      try { text = await f.text(); }
      catch { return toast("Couldn't read that file. Try exporting it as CSV again.", "x"); }
      if (text.includes("\0")) {
        return toast("That file looks binary, not a text sheet. Export the responses as CSV and upload that.", "x");
      }
      loadRows(state, text, f.name);
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
  // Capacity is a soft cap for the organiser's OWN list: warn plainly if
  // this batch runs past it, but never block — their registrations are
  // their call. (RSVP self-service is the hard gate, in rsvpEvent: the
  // issued count this batch raises is exactly what waitlists people.)
  if (state.unified && state.capacity > 0 && state.total + total > state.capacity) {
    toast(`Over capacity: ${state.total} passes + ${total} more passes the ${state.capacity} limit — generating anyway, it's your list`, "x");
  }
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
    state.reminded = new Set(state.passes.filter((p) => p.reminded_at).map((p) => p.id));
    // A reload can newly fail (or recover) the RSVP half — keep the
    // incompleteness hint honest either way.
    if (state.unified) state.rsvpError = state.passes.rsvpError || "";
    const gate = await withTimeout(fb.joinGate(state.ev.gate_code));
    // Unified dashboards recount from the list itself (it now includes any
    // passes just generated); legacy ones keep the gate doc's total.
    if (state.unified) state.total = state.passes.length;
    else if (gate) state.total = gate.counts.total;
  } catch {}
  renderReg(state); renderStat(state); renderPassTools(state); renderList(state);
}

// ── checked-in counter ──
const fmtHour = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;

// Per-gate breakdown + busiest hour, derived entirely from the claim docs
// the dashboard already loads (first scans plus their repeats) — no new
// counters are stored anywhere. A repeat counts against the gate where
// the repeat scan happened, which is the gate that turned the person
// away. The structured breakdown is shared by the dashboard's stat card
// (gateStatsHtml) and the post-event report.
function gateBreakdown(claims) {
  const gates = new Map(), hours = new Map();
  const bump = (name, key) => {
    const g = gates.get(name) || { in: 0, bounced: 0 };
    g[key]++;
    gates.set(name, g);
  };
  for (const c of claims || []) {
    bump(c.gate || "Gate", "in");
    if (c.scanned_at) {
      const h = new Date(c.scanned_at).getHours();
      if (!isNaN(h)) hours.set(h, (hours.get(h) || 0) + 1);
    }
    for (const r of c.repeats || []) bump(r.gate || c.gate || "Gate", "bounced");
  }
  let busiest = null;
  if (hours.size) {
    const [h, n] = [...hours.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    busiest = { hour: h, count: n };
  }
  return {
    gates: [...gates.entries()]
      .sort((a, b) => b[1].in - a[1].in || a[0].localeCompare(b[0]))
      .map(([name, g]) => ({ name, in: g.in, bounced: g.bounced })),
    busiest,
  };
}

// Renders nothing until the first scan exists.
function gateStatsHtml(claims) {
  if (!claims?.length) return "";
  const { gates, busiest } = gateBreakdown(claims);
  const rows = gates
    .map((g) => `<p class="stat-note"><b>${esc(g.name)}</b> — ${g.in} in${g.bounced ? ` · ${g.bounced} bounced` : ""}</p>`)
    .join("");
  const busy = busiest
    ? `<p class="stat-note">Busiest hour: ${fmtHour(busiest.hour)}–${fmtHour((busiest.hour + 1) % 24)} · ${plural(busiest.count, "check-in")}</p>`
    : "";
  return rows + busy;
}

function renderStat(state, bump = false) {
  const total = state.total ?? state.passes.length, checked = state.checked ?? state.first.size;
  const el = view.querySelector("#stat");
  el.innerHTML = `
    <span class="dot">${I.dotCheck}</span>
    <p class="stat-label">Checked in</p>
    <div class="stat-line"><p class="stat-num ink" id="snum">${checked} / ${total}</p><div class="bar" aria-hidden="true"><i style="--p:${total ? Math.min(1, checked / total) : 0}"></i></div></div>
    ${state.bounced ? `<p class="stat-note">${plural(state.bounced, "repeat scan")} bounced at the gate</p>` : ""}
    ${state.unified && state.capacity ? `<p class="stat-note">Spots filled: ${total} / ${state.capacity}${state.waitlist?.length ? ` · ${plural(state.waitlist.length, "person", "people")} waiting` : ""}</p>` : ""}
    ${gateStatsHtml(state.claims)}
    ${state.stampError ? `<p class="stat-note err">${esc(state.stampError)}</p>` : ""}
    ${state.waitlistError ? `<p class="stat-note err">${esc(state.waitlistError)}</p>` : ""}
    ${state.rsvpError ? `<p class="stat-note err">${esc(state.rsvpError)}</p>` : ""}
    ${state.totalError ? `<p class="stat-note err">${esc(state.totalError)}</p>` : ""}`;
  el.setAttribute("aria-label", `Checked in ${checked} of ${total}`);
  if (bump) { const n = el.querySelector("#snum"); n.animate([{ transform: "scale(1.08)", color: "#D4107F" }, { transform: "scale(1)" }], { duration: 520, easing: "cubic-bezier(.16,1,.3,1)" }); }
}

// ─────────────────────────────────────────────── post-event report
// A screenshot-clean recap of a v2 event, derived entirely from the
// data the dashboard already loads for the owner — the unified pass
// list, the claim docs (first scans + repeats), the waitlist and the
// RSVP docs. Nothing new is stored and no counter is kept anywhere:
// reopen the report after more scans and it recomputes from reality.
//
// Definitions, kept exact so the tiles always agree with each other:
//   issued    = passes in the unified list
//   checkedIn = issued passes with a first-scan claim (issued − no-shows)
//   turnout % = checkedIn / issued, rounded
//   bounced   = repeat scans across all claims (the gate turned them away)
//   waiting   = members currently on the waitlist
//   promoted  = approved RSVPs carrying promoteWaitlist's explicit
//               waitlistPosition:null stamp — the only promotion trace
//               the data keeps (see listRsvps). A queued member who
//               re-RSVPs into a freed spot is issued by rsvpEvent with
//               the doc rewritten, which erases the stamp, so this
//               count is a floor, never an invention.
// The check-in curve and the per-gate split read ALL first claims (the
// gate's own truth), bucketed per 30 minutes from the first claim's
// half-hour — anchoring at doors-open rather than the event's listed
// start, because entry flow is what the curve is about.
const HALF_HOUR = 30 * 60 * 1000;

function computeReport({ passes, claims, waitlist, rsvps }) {
  const ordered = [...passes].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const firstByPass = new Map();
  for (const c of claims || []) if (c.is_first && !firstByPass.has(c.pass_id)) firstByPass.set(c.pass_id, c);
  const noShows = ordered.filter((p) => !firstByPass.has(p.id));
  const issued = ordered.length;
  const checkedIn = issued - noShows.length;
  const bounced = (claims || []).reduce((n, c) => n + (c.repeats?.length || 0), 0);
  const times = (claims || [])
    .filter((c) => c.is_first && c.scanned_at)
    .map((c) => new Date(c.scanned_at).getTime())
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b);
  let buckets = [], peak = null, firstAt = null, lastAt = null;
  if (times.length) {
    firstAt = times[0];
    lastAt = times[times.length - 1];
    const anchor = new Date(firstAt);
    anchor.setSeconds(0, 0);
    anchor.setMinutes(anchor.getMinutes() >= 30 ? 30 : 0);
    const start = anchor.getTime();
    buckets = Array.from({ length: Math.floor((lastAt - start) / HALF_HOUR) + 1 }, (_, i) => ({ start: start + i * HALF_HOUR, count: 0 }));
    for (const t of times) buckets[Math.floor((t - start) / HALF_HOUR)].count++;
    peak = buckets.reduce((a, b) => (b.count > a.count ? b : a), buckets[0]);
  }
  const { gates, busiest } = gateBreakdown(claims);
  const promoted = rsvps
    ? rsvps.filter((x) => x.status === "approved" && x.waitlist_stamped && x.waitlist_position === null).length
    : null;
  return {
    issued, checkedIn, noShows, bounced,
    turnout: issued ? Math.round((checkedIn / issued) * 100) : 0,
    buckets, peak, firstAt, lastAt, gates, busiest,
    waiting: waitlist?.length || 0, promoted,
  };
}

// "6:30–7:00 PM" — the meridiem prints once when both ends share it.
function fmtWindow(startMs) {
  const fa = fmtTime(new Date(startMs)), fb = fmtTime(new Date(startMs + HALF_HOUR));
  return `${fa.slice(-2) === fb.slice(-2) ? fa.slice(0, -3) : fa}–${fb}`;
}

function reportSummaryText(ev, r) {
  const lines = [
    `${typo(ev.name)} — entry report`,
    `${fmtWhen(ev.starts_at)}${ev.venue ? ` · ${ev.venue}` : ""}`,
    `Passes issued: ${r.issued}`,
    `Turned up: ${r.checkedIn} (${r.turnout}%)`,
    `Repeat scans bounced: ${r.bounced}`,
  ];
  if (r.peak) lines.push(`Peak entry: ${fmtWindow(r.peak.start)} · ${plural(r.peak.count, "check-in")}`);
  for (const g of r.gates) lines.push(`${g.name}: ${g.in} in${g.bounced ? ` · ${g.bounced} bounced` : ""}`);
  if (r.waiting) lines.push(`Still on the waitlist: ${r.waiting}`);
  if (r.promoted) lines.push(`Promoted from the waitlist: ${r.promoted}`);
  if (r.noShows.length) lines.push(`Didn't show: ${r.noShows.map((p) => p.name).join(", ")}`);
  return lines.join("\n");
}

async function reportView(id) {
  view.innerHTML = `<div class="skeleton" style="height:520px"></div>`;
  let v2 = null;
  try { v2 = await withTimeout(fb.getV2Event(id)); } catch {}
  if (!v2 || v2.ownerId !== session.uid) {
    toast("That event isn't yours or was deleted", "x");
    location.hash = `#/e/${id}`;
    return;
  }
  let loaded;
  try { loaded = await loadV2State(v2); }
  catch (e) { return fail(e); }
  // The promoted count reads the RSVP docs themselves — the one read
  // loadV2State doesn't surface. A failure hides just that one tile
  // (loudly, like the dashboard's other load hints), never the report.
  let rsvps = null, rsvpsError = "";
  try { rsvps = await withTimeout(fb.listRsvps(id)); }
  catch (e) {
    console.error("[GatePass] report RSVP load failed:", e);
    rsvpsError = "The RSVP list couldn't be loaded, so the promoted-from-waitlist count is hidden. If this keeps showing, the Firestore rules on the Firebase project are out of date — re-publish firestore.rules from the repo.";
  }
  return renderReport({ ...loaded, rsvps, rsvpsError });
}

function renderReport({ ev, passes, claims, waitlist, rsvps, rsvpsError }) {
  const r = computeReport({ passes, claims, waitlist, rsvps });
  const maxBucket = r.buckets.reduce((m, b) => Math.max(m, b.count), 0);
  document.title = `${typo(ev.name)} report · GatePass`;
  view.innerHTML = `
    <a class="backlink" href="#/e/${ev.id}">${I.back}Back to the event</a>
    <div class="stack narrow">
      <div class="poster" id="repPoster">
        <h1 class="poster-title ink">${escT(ev.name)}</h1>
        <span class="poster-when">${esc(fmtWhen(ev.starts_at))}${ev.venue ? ` · ${esc(ev.venue)}` : ""}</span>
      </div>
      <div class="head-row"><h2 class="head">Entry report</h2><button class="btn small" type="button" id="repCopy">${I.copy}Copy summary</button></div>
      <div class="stat grain">
        <span class="dot">${I.dotCheck}</span>
        <p class="stat-label">Turnout</p>
        <div class="stat-line"><p class="stat-num ink">${r.turnout}%</p><div class="bar" aria-hidden="true"><i style="--p:${r.issued ? r.checkedIn / r.issued : 0}"></i></div></div>
        <p class="stat-note">${r.checkedIn} of ${plural(r.issued, "pass", "passes")} checked in</p>
      </div>
      <div class="rep-stats">
        <div class="rep-tile"><b>${r.issued}</b><span>Passes issued</span></div>
        <div class="rep-tile"><b>${r.checkedIn}</b><span>Checked in</span></div>
        <div class="rep-tile"><b>${r.bounced}</b><span>Repeat scans bounced</span></div>
        <div class="rep-tile"><b>${r.waiting}</b><span>Still waiting</span></div>
        ${r.promoted !== null ? `<div class="rep-tile"><b>${r.promoted}</b><span>Promoted from waitlist</span></div>` : ""}
      </div>
      ${rsvpsError ? `<p class="err" role="alert">${esc(rsvpsError)}</p>` : ""}
      <section class="rep-card">
        <h3 class="rep-h">Check-in curve</h3>
        ${r.buckets.length ? `
          <div class="rep-bars" role="img" aria-label="Check-ins per half hour, peaking at ${esc(fmtWindow(r.peak.start))} with ${r.peak.count}">
            ${r.buckets.map((b) => `
              <div class="rep-bar${b.start === r.peak.start ? " is-peak" : ""}">
                <span class="rep-bar-n">${b.count}</span>
                <i style="--h:${maxBucket ? b.count / maxBucket : 0}"></i>
                <span class="rep-bar-t">${esc(fmtTime(new Date(b.start)))}</span>
              </div>`).join("")}
          </div>
          <p class="rep-peak">Peak entry: ${esc(fmtWindow(r.peak.start))} · ${plural(r.peak.count, "check-in")}</p>
          <p class="fine" style="margin:0">First check-in ${esc(fmtTime(new Date(r.firstAt)))} · Last check-in ${esc(fmtTime(new Date(r.lastAt)))}</p>`
        : `<p class="fine" style="margin:0">No check-ins yet — the curve fills in as the gate scans.</p>`}
      </section>
      ${r.gates.length ? `
      <section class="rep-card">
        <h3 class="rep-h">By gate</h3>
        ${r.gates.map((g) => `<p class="rep-line"><b>${esc(g.name)}</b> — ${g.in} in${g.bounced ? ` · ${g.bounced} bounced` : ""}</p>`).join("")}
        ${r.busiest ? `<p class="rep-line">Busiest hour: ${fmtHour(r.busiest.hour)}–${fmtHour((r.busiest.hour + 1) % 24)} · ${plural(r.busiest.count, "check-in")}</p>` : ""}
      </section>` : ""}
      <section class="rep-card">
        <h3 class="rep-h">Didn't show (${r.noShows.length})</h3>
        ${!r.issued ? `<p class="fine" style="margin:0">No passes issued yet — send some out and this list names whoever stays away.</p>`
        : r.noShows.length ? `<div class="rep-scroll"><ul class="passlist">${r.noShows.map((p) => `
            <li>
              <p class="pl-name">${esc(p.name)}</p>
              <p class="pl-meta"><span class="pl-src">${PASS_SOURCE[p.source] || "Added by you"}</span></p>
            </li>`).join("")}</ul></div>`
        : `<p class="fine" style="margin:0">Everyone with a pass showed up.</p>`}
      </section>
    </div>`;
  view.querySelector("#repPoster").style.backgroundImage = `url("${artUrl(ev.art)}")`;
  view.querySelector("#repCopy").addEventListener("click", async () => {
    (await copyText(reportSummaryText(ev, r))) ? toast("Summary copied") : toast("Couldn't copy", "x");
  });
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

function remindMsgFor(state, p) {
  const ev = state.ev;
  const first = p.name.split(" ")[0];
  return `Hi ${first}! A reminder that ${ev.name} is on ${fmtWhen(ev.starts_at)}${ev.venue ? ` at ${ev.venue}` : ""}. Your pass:\n${passUrl(p.token)}\nShow the QR at the gate. It works once, so don't share it.`;
}
// Pass holders a reminder can still reach: a phone WhatsApp can open,
// and NOT checked in yet — reminding someone already inside is noise.
// Checked-in state is the claim map, the same authority the counter uses.
function remindAudience(state) {
  return state.passes.filter((p) => !state.first.has(p.id) && !!sendHref(state, p)?.href);
}

// The reminder box's header line, in the delivery queue's words: the
// counts describe pass holders who haven't checked in yet, split by
// whether WhatsApp can reach them at all.
function remindHead(state) {
  const notIn = state.passes.filter((p) => !state.first.has(p.id));
  if (!notIn.length) return "every pass holder has checked in already, so there is nobody left to remind.";
  const reachable = remindAudience(state).length;
  const noPhone = notIn.length - reachable;
  return `for pass holders who haven't checked in yet. ${reachable} of ${notIn.length} still to come have a phone number${noPhone ? `; ${noPhone} ${noPhone === 1 ? "has" : "have"} no phone — use Email or Copy link for those` : ""}.`;
}

// The reminder twin of noteWaSent: the marker persists on the pass
// (remindedAt, via state.markReminded) so nobody is reminded twice from
// the queue and the count survives reloads. Optimistic with rollback,
// and honest in the same way — it records the wa.me draft being opened,
// never a WhatsApp delivery.
function noteReminded(state, p, refresh) {
  if (!p || state.reminded.has(p.id)) { refresh?.(); return; }
  state.reminded.add(p.id);
  const prev = p.reminded_at;
  p.reminded_at = new Date().toISOString();
  refresh?.();
  Promise.resolve(state.markReminded?.(p)).catch(() => {
    state.reminded.delete(p.id);
    p.reminded_at = prev;
    refresh?.();
    toast("Couldn't save the reminder marker — count rolled back", "x");
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
      <p class="fine" style="margin:0"><b>WhatsApp delivery</b> — ${waPasses(state).length} of ${state.passes.length} passes have a phone number${state.passes.length - waPasses(state).length ? `; ${state.passes.length - waPasses(state).length} ${state.passes.length - waPasses(state).length === 1 ? "has" : "have"} no phone — use Email or Copy link for those` : ""}. Each tap opens one WhatsApp chat with that person's pass already written in — you tap Send. Nothing is sent automatically. Each tap is marked on the pass, so the count survives reloads.</p>
      <div class="btns">
        <button class="btn small" type="button" id="waNext">${I.chat}Send next on WhatsApp</button>
        <button class="btn small" type="button" id="waCopyAll">${I.copy}Copy all WhatsApp messages</button>
      </div>
      <p class="fine" id="waStatus" style="margin:0">${state.waSent.size ? `${state.waSent.size} marked as sent` : "Not started yet — the first tap opens the first phone number on the list."}</p>
    </div>
    ${state.markReminded ? `
    <div class="stack" id="remindBox" style="gap:8px">
      <p class="fine" style="margin:0"><b>WhatsApp reminders</b> — ${remindHead(state)} Each tap opens one WhatsApp chat with that person's reminder already written in — you tap Send. Nothing is sent automatically. Each tap is marked on the pass, so nobody is reminded twice and the count survives reloads.</p>
      <div class="btns">
        <button class="btn small" type="button" id="remindNext">${I.chat}Send next reminder</button>
        <button class="btn small" type="button" id="remindCopyAll">${I.copy}Copy all reminder messages</button>
      </div>
      <p class="fine" id="remindStatus" style="margin:0">Not started yet.</p>
    </div>` : ""}
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
    // Both numbers describe the SAME subset — passes with a phone number —
    // and the label says so: "0 of 3" used to sit next to a 5-pass header
    // and read as if two people had been forgotten (live test, 27 Nov).
    const wa = waPasses(state);
    const done = wa.filter((p) => state.waSent.has(p.id)).length, total = wa.length;
    const statusEl = el.querySelector("#waStatus");
    const nextBtn = el.querySelector("#waNext");
    if (!total) {
      statusEl.textContent = "No passes have a phone number yet — add a phone column when you upload, or use Email / Copy link for those rows.";
      nextBtn.disabled = true;
      return;
    }
    const next = wa.find((p) => !state.waSent.has(p.id) && sendHref(state, p)?.href);
    statusEl.textContent = done >= total
      ? `All ${total} with phone numbers marked as sent. Reopen any row's WhatsApp button to resend one.`
      : next
        ? `${done} of ${total} with phone numbers marked as sent — next: ${next.name}.`
        : `${done} of ${total} with phone numbers marked as sent — the rest have numbers WhatsApp can't open; use Email or Copy link for those.`;
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
  // Reminder queue (v2 dashboards): the delivery queue's interaction
  // model aimed at a different audience — pass holders who haven't
  // checked in yet — with its own persisted marker, so the two queues
  // never double-count each other.
  if (state.markReminded) {
    const remindStatus = () => {
      // Both numbers describe the SAME subset — phone-holders not yet
      // checked in — and the label says so, like the delivery status.
      const audience = remindAudience(state);
      const statusEl = el.querySelector("#remindStatus");
      const nextBtn = el.querySelector("#remindNext");
      const done = audience.filter((p) => state.reminded.has(p.id)).length, total = audience.length;
      if (!total) {
        statusEl.textContent = state.passes.some((p) => sendHref(state, p)?.href)
          ? "Everyone with a phone number has already checked in — nobody left to remind."
          : "No pass holders have a phone number — reminders go out on WhatsApp, so use Email or Copy link for those.";
        nextBtn.disabled = true;
        return;
      }
      const next = audience.find((p) => !state.reminded.has(p.id));
      statusEl.textContent = done >= total
        ? `All ${total} with phone numbers reminded.`
        : next
          ? `${done} of ${total} with phone numbers reminded — next: ${next.name}.`
          : `${done} of ${total} with phone numbers reminded — the rest have numbers WhatsApp can't open; use Email or Copy link for those.`;
      nextBtn.disabled = !next;
    };
    state.refreshRemind = remindStatus;
    el.querySelector("#remindNext").addEventListener("click", () => {
      const next = remindAudience(state).find((p) => !state.reminded.has(p.id));
      if (!next) return remindStatus();
      const d = normalizePhone(next.contact);
      if (!d) return remindStatus();
      window.open(`https://wa.me/${d}?text=${encodeURIComponent(remindMsgFor(state, next))}`, "_blank", "noopener");
      noteReminded(state, next, () => { remindStatus(); renderList(state); });
    });
    el.querySelector("#remindCopyAll").addEventListener("click", async () => {
      const audience = remindAudience(state);
      if (!audience.length) return;
      const text = audience.map((p) => remindMsgFor(state, p)).join("\n\n");
      (await copyText(text)) ? toast(`${plural(audience.length, "reminder")} copied`) : toast("Couldn't copy", "x");
    });
    remindStatus();
  }
  let t;
  el.querySelector("#filter").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.filter = e.target.value; state.shown = 120; renderList(state); }, 120); });
}

// Where a pass came from, in the organiser's words. Legacy (v1) passes
// carry no source field — they were all sheet-issued from this dashboard.
const PASS_SOURCE = { organiser: "Added by you", rsvp: "RSVP", guest: "Guest RSVP" };

function rowHtml(state, p) {
  const s = state.first.get(p.id);
  const send = sendHref(state, p);
  return `
    <li data-id="${p.id}">
      <p class="pl-name">${esc(p.name)}</p>
      <p class="pl-meta">${s ? `<span class="in">In ${esc(fmtTime(s.scanned_at))} · ${esc(s.gate)}</span> · ` : ""}<span class="pl-src">${PASS_SOURCE[p.source] || "Added by you"}</span> · ${esc(p.contact || "no contact")}${state.waSent.has(p.id) ? ` · WhatsApp marked sent` : ""}${state.reminded.has(p.id) ? ` · Reminder marked sent` : ""}</p>
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

// ── payments (paid v2 events) ──
// Orders live on the RSVP docs, one per member. The pill wording is the
// honesty contract of the whole feature: a payment the member's browser
// reported is PAID (UNVERIFIED) — real money only once the server-side
// verifier has confirmed it with Razorpay (docs/paid-passes.md) — and
// the collected total is labelled client-reported for the same reason.
function renderPayments(state) {
  const slot = view.querySelector("#paySlot");
  if (!slot) return;
  const p = state.payments;
  if (!state.unified || !p || !(p.amountPaise > 0)) { slot.innerHTML = ""; return; }
  const orders = p.orders || [];
  const collected = orders
    .filter((o) => o.pay_status === "client_paid_unverified")
    .reduce((sum, o) => sum + (o.amount_paise || 0), 0);
  const verified = orders
    .filter((o) => o.pay_status === "verified")
    .reduce((sum, o) => sum + (o.amount_paise || 0), 0);
  const pill = (o) => o.pay_status === "verified"
    ? `<span class="pay-pill is-verified">Paid (verified)</span>`
    : o.pay_status === "client_paid_unverified"
      ? `<span class="pay-pill is-unverified">Paid (unverified)</span>`
      : `<span class="pay-pill is-unpaid">Unpaid</span>`;
  slot.innerHTML = `
    <div class="head-row section-gap-m"><h2 class="head">Payments</h2><span class="fine">${esc(formatPaise(p.amountPaise))} per pass</span></div>
    <p class="fine" style="margin:0 0 6px">Collected (client-reported): <strong>${esc(formatPaise(collected))}</strong>${verified ? ` · Verified: <strong>${esc(formatPaise(verified))}</strong>` : ""}</p>
    <p class="fine" style="margin:0 0 10px">Amounts are reported by each payer's browser until the payment verifier runs — treat PAID (UNVERIFIED) as “probably paid”, never as confirmed money. See docs/paid-passes.md.</p>
    ${orders.length ? `<ul class="passlist" id="paylist">${orders.map((o) => `
      <li data-payid="${esc(o.uid)}">
        <p class="pl-name">${esc(o.name || "Guest")}</p>
        <p class="pl-meta">${esc(formatPaise(o.amount_paise || p.amountPaise))} · ${pill(o)}${o.razorpay_payment_id ? ` · <span class="pay-id">${esc(o.razorpay_payment_id)}</span>` : ""}</p>
      </li>`).join("")}</ul>`
    : `<p class="fine">No orders yet — an order appears here the moment someone RSVPs to this paid event.</p>`}`;
}

// ── waitlist ──
// Queued members hold no pass, so they live outside the pass list: their
// own section, in queue order, with the one management action that makes
// sense here — removal (a rejection with nothing to revoke). The section
// renders only for unified (v2) dashboards that can fill up: an event
// with a capacity, or a queue left over from when it had one.
function renderWaitlist(state) {
  const slot = view.querySelector("#waitlistSlot");
  if (!slot) return;
  const rows = state.waitlist || [];
  if (!state.unified || (!state.capacity && !rows.length)) { slot.innerHTML = ""; return; }
  slot.innerHTML = `
    <div class="head-row section-gap-m"><h2 class="head">Waitlist</h2><span class="fine" id="wcount">${rows.length ? `${plural(rows.length, "person", "people")} waiting` : ""}</span></div>
    ${rows.length ? `<ul class="passlist" id="wlist">${rows.map((w) => `
      <li data-wid="${esc(w.uid)}">
        <p class="pl-name">#${w.position} · ${esc(w.name || "Guest")}</p>
        <p class="pl-meta"><span class="pl-src">${w.via === "guest" ? "Guest RSVP" : "RSVP"}</span> · ${esc(w.phone || w.email || "no contact")}</p>
        <div class="pl-actions">
          <button class="icon-btn" type="button" data-wremove="${esc(w.uid)}" aria-label="Remove ${esc(w.name || "guest")} from the waitlist" title="Remove from waitlist">${I.trash}</button>
        </div>
      </li>`).join("")}</ul>`
    : `<p class="fine">Nobody is waiting — the waitlist fills when the event reaches capacity, and queued guests are promoted automatically when a spot frees.</p>`}`;
  slot.querySelectorAll("[data-wremove]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await withTimeout(state.removeFromWaitlist(b.dataset.wremove), 30000);
      state.waitlist = await withTimeout(state.reloadWaitlist());
      renderWaitlist(state);
      renderStat(state);
      toast("Removed from the waitlist");
    } catch (e) {
      b.disabled = false;
      toast(e.message || "Couldn't remove them", "x");
    }
  }));
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
// Stamp-sync failures used to vanish into .catch(() => {}) — a denied
// mirror write looked exactly like success from the dashboard (27 Nov
// 2026: the claim existed, the scanner showed the check-in, and the pass
// page never updated, three live tests in a row). Surface them instead:
// console for devtools, a throttled toast for the organiser, and — on the
// event dashboard — the persistent hint renderStat draws from
// state.stampError.
let lastStampToast = 0;
function surfaceStampError(where, e) {
  console.error(`[GatePass] ${where} failed:`, e);
  const now = Date.now();
  if (now - lastStampToast > 60000) {
    lastStampToast = now;
    toast("Couldn't sync check-in stamps to the pass pages.", "x");
  }
}

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
        state.claims = claims;
        state.first = new Map();
        for (const claim of claims) if (claim.is_first) state.first.set(claim.pass_id, claim);
        state.checked = state.first.size;
        state.bounced = lastBounced;
        // Mirror new claims onto the pass docs so the pass pages show
        // "Checked in": gate scans write the claim (the only scan
        // authority), and this mirror is its attendee-visible copy for
        // every scan the gate-side projection couldn't stamp (older rule
        // sets, or a scan whose projection write was interrupted). This
        // must run for BOTH event kinds — v2 passes previously "relied on"
        // the gate's best-effort stamp, but gate staff are signed out and
        // the old rules denied that write, so a scanned v2 pass page NEVER
        // updated (live test, 27 Nov 2026).
        // The mirror runs FIRST, before any rendering, and its errors are
        // surfaced, never swallowed: a render throw must not be able to
        // starve it, and a denied write (e.g. the published rules lagging
        // the repo's) must be visible instead of looking exactly like
        // success — the combination that hid this bug for three live
        // tests. Failed passes stay unmarked so the next refresh retries.
        const fresh = claims.filter((c) => c.is_first && !state.stamped.has(c.pass_id));
        if (fresh.length) {
          try {
            await fb.stampPassesFromClaims(state.passes, fresh);
            fresh.forEach((c) => state.stamped.add(c.pass_id));
            state.stampError = "";
          } catch (e) {
            state.stampError = "Check-in stamps aren't reaching the pass pages. If this keeps showing, the Firestore rules on the Firebase project are out of date — re-publish firestore.rules from the repo.";
            surfaceStampError("dashboard stamp mirror", e);
          }
        }
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
  // Run one refresh immediately: claims that already exist when the
  // dashboard opens must be mirrored now, not only when the next gate-doc
  // snapshot happens to land.
  refresh();
}
function stopLive() {
  if (live) { live(); live = null; }
  if (regUnsub) { regUnsub(); regUnsub = null; }
  if (activeFest) { activeFest.alive = false; activeFest = null; }
}

paintIcons();
wireThemeToggles();
boot().catch(fail);

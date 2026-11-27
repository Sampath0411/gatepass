// Public registration: a student signs in with Google, claims one spot for a
// sub-event, and lands straight on their QR pass. All Firestore writes live in
// firebase.js; this module owns only the screen state and the friendly copy.
import {
  configured, passUrl, fmtWhen, esc, escT, setArt, toast, I, DB_MSG, wireThemeToggles,
} from "./core.js";
import * as fb from "./firebase.js";

const view = document.getElementById("view");
const $ = (id) => view.querySelector(`#${id}`);

// The organiser links to `register/#/register/{eventId}`; a plain `#/{eventId}`
// or `?event={eventId}` link works too, so shared links stay forgiving.
function eventIdFromLocation() {
  const hash = location.hash || "";
  const named = hash.match(/^#\/?register\/([A-Za-z0-9_-]+)/);
  if (named) return named[1];
  const bare = hash.match(/^#\/?([A-Za-z0-9_-]{8,})$/);   // Firestore auto-IDs are 20 chars
  if (bare) return bare[1];
  const q = new URLSearchParams(location.search);
  return q.get("event") || q.get("eventId") || q.get("id") || "";
}
const EVENT_ID = eventIdFromLocation();

let user = null;
let desc = null;

// Never show a student a raw Firestore code (e.code) — translate to plain words.
function friendlyError(e) {
  const code = e?.code || "";
  if (/unavailable|deadline-exceeded|network|aborted|internal/i.test(code)) return DB_MSG;
  if (/permission-denied|unauthenticated|invalid-argument|failed-precondition/i.test(code))
    return "Registration isn't available right now. Ask the organiser to check the link.";
  if (/already-exists|duplicate/i.test(code)) return "It looks like you're already registered for this event.";
  return "We couldn't complete your registration. Please try again in a moment.";
}

function showError(el, msg) { el.textContent = msg; el.hidden = false; }

function skeleton() { view.innerHTML = `<div class="skeleton" style="height:420px"></div>`; }

// ══ boot ══════════════════════════════════════════════════════════════════════

async function boot() {
  document.title = "Register · GatePass";
  if (!configured || !fb.configured) return notConfigured();
  if (!EVENT_ID) return invalidLink();
  skeleton();
  // Finish a Google sign-in that had to fall back from a popup to a redirect.
  await fb.redirectResult().catch(() => {});
  // The descriptor doc is signed-in-readable, so it is only fetched once Auth
  // has a user. onAuth fires immediately with the current (possibly null) user.
  fb.onAuth((u) => {
    if (u && user && u.uid === user.uid) return;   // same sign-in, already rendered
    user = u;
    if (!u) return signInView();
    loadDescriptor();
  });
}

async function loadDescriptor() {
  skeleton();
  try {
    desc = await fb.getRegistrationDescriptor(EVENT_ID);
  } catch (e) {
    return fail(e);
  }
  if (!desc) return invalidLink();
  renderEvent();
}

// ══ screens ═══════════════════════════════════════════════════════════════════

function notConfigured() {
  view.innerHTML = `
    <section class="stack narrow">
      <div class="poster hero-poster" id="art">
        <h1 class="poster-title ink">Almost there</h1>
        <p class="poster-club">Connect your Firebase project</p>
      </div>
      <h2 class="head">Registration isn't set up yet</h2>
      <p class="sub">The organiser still needs to connect this site to Firebase. Ask them to finish setup, then open this link again.</p>
    </section>`;
  setArt($("art"), 0);
}

function invalidLink() {
  view.innerHTML = `
    <section class="empty">
      <h3>Link no longer valid</h3>
      <p class="sub">This registration link has expired, or the organiser has replaced it. Ask them for the current link and try again.</p>
      <p style="margin-top:14px"><a class="btn small" href="../">Back to GatePass</a></p>
    </section>`;
}

function fail(e) {
  view.innerHTML = `
    <section class="empty">
      <h3>Couldn't load this event</h3>
      <p class="sub">${esc(friendlyError(e))}</p>
      <p style="margin-top:14px"><button class="btn small" type="button" id="retry">${I.refresh}Try again</button></p>
    </section>`;
  $("retry").addEventListener("click", () => loadDescriptor());
}

function signInView(msg = "") {
  view.innerHTML = `
    <section class="stack narrow">
      <div class="poster hero-poster" id="art">
        <h1 class="poster-title ink">Your pass starts here</h1>
        <p class="poster-club">Sign in to register</p>
      </div>
      <div class="stack" style="margin-top:6px">
        <h2 class="head">Sign in to register</h2>
        <p class="sub">Use your Google account. We only use it to give you one pass for this event.</p>
        <p class="err" id="signErr" role="alert" ${msg ? "" : "hidden"}>${esc(msg)}</p>
        <button class="btn-primary compact" type="button" id="google">
          <span class="gdisc">${I.google}</span><span class="label">Continue with Google</span><span class="arrow">${I.arrow}</span>
        </button>
        <p class="fine" style="margin:0">No password to remember. Gate staff join with a code; attendees just sign in.</p>
      </div>
    </section>`;
  setArt($("art"), 0);
  $("google").addEventListener("click", async () => {
    const btn = $("google");
    btn.disabled = true;
    try {
      await fb.signIn();   // falls back to a redirect if the popup is blocked
    } catch (e) {
      showError($("signErr"), friendlyError(e));
      btn.disabled = false;
    }
  });
}

const accountLine = () => `
  <p class="fine" style="margin:0">Signed in as <b>${esc(user.email || "your Google account")}</b> ·
    <button class="btn small" type="button" id="signout" style="min-height:32px;padding:4px 10px">Sign out</button></p>`;

function eventPoster() {
  return `
    <div class="poster hero-poster" id="art">
      <h1 class="poster-title ink">${escT(desc.name)}</h1>
      <p class="poster-club">${escT(desc.club || "GatePass event")}</p>
      ${desc.starts_at ? `<span class="poster-when">${esc(fmtWhen(desc.starts_at))}</span>` : ""}
    </div>`;
}

function formMarkup() {
  const where = [desc.venue, desc.starts_at ? fmtWhen(desc.starts_at) : ""].filter(Boolean).map(esc).join(" · ");
  return `
    <div>
      <h2 class="head">Register for this event</h2>
      <p class="sub" style="margin-top:6px">${where ? `${where} · ` : ""}Your QR pass is ready the moment you submit.</p>
    </div>
    <form id="regForm" class="stack" novalidate>
      <label class="field">
        <span>Full name</span>
        <input class="input" id="fName" name="name" type="text" autocomplete="name" maxlength="80" placeholder="Your name" required>
      </label>
      <label class="field">
        <span>Email (optional)</span>
        <input class="input" id="fEmail" name="email" type="email" autocomplete="email" maxlength="120" placeholder="you@example.com">
      </label>
      <label class="field">
        <span>Phone (optional)</span>
        <input class="input" id="fPhone" name="phone" type="tel" autocomplete="tel" maxlength="20" placeholder="Your mobile number">
      </label>
      <p class="err" id="regErr" role="alert" hidden></p>
      <button class="btn-primary compact" type="submit" id="regBtn">
        <span class="label">Get my pass</span><span class="arrow">${I.arrow}</span>
      </button>
    </form>
    ${accountLine()}`;
}

function renderEvent() {
  const closed = !desc.registration_open;
  const full = desc.capacity > 0 && desc.total >= desc.capacity;
  view.innerHTML = `
    <section class="stack narrow">
      ${eventPoster()}
      ${closed ? `
        <h2 class="head">Registration closed</h2>
        <p class="sub">The organiser has closed registration for this event. If you already have a pass, it's still in your GatePass links.</p>
        ${accountLine()}` : full ? `
        <h2 class="head">This event is full</h2>
        <p class="sub">All the places have been taken. Check back in case the organiser opens up more spots.</p>
        ${accountLine()}` : formMarkup()}
    </section>`;
  setArt($("art"), desc.art || 0);
  $("signout").addEventListener("click", async () => {
    await fb.signOutUser();
    user = null;
    signInView();
  });
  if (!closed && !full) wireForm();
}

function wireForm() {
  $("regForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("regErr");
    err.hidden = true;

    const name = $("fName").value.trim();
    const email = $("fEmail").value.trim();
    const phone = $("fPhone").value.trim();
    if (!name) return showError(err, "Please enter your name.");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return showError(err, "That email doesn't look right — check it, or leave it blank.");
    if (phone && !/^[+\d][\d\s()-]{4,}$/.test(phone))
      return showError(err, "That phone number doesn't look right — check it, or leave it blank.");

    const btn = $("regBtn");
    btn.disabled = true;
    btn.querySelector(".label").textContent = "Getting your pass…";
    try {
      const result = await fb.registerStudentWithCode(
        desc, user, { name, email, phone, contact: email || phone }, desc.gate_code);
      toast("You're registered — show this at the gate");
      // Let the confirmation land before handing them over to their pass.
      setTimeout(() => { location.href = passUrl(result.token); }, 1100);
    } catch (e2) {
      showError(err, friendlyError(e2));
      btn.disabled = false;
      btn.querySelector(".label").textContent = "Get my pass";
    }
  });
}

wireThemeToggles();
boot();

// Luma-style events homepage — feed, calendar, discover, create, detail + RSVP.
import * as fb from "./firebase.js";
import {
  ART, I, artUrl, esc, fmtWhen, fmtTime, passUrl, gateUrl, fmtCode, copyText,
  configured as coreConfigured, toast, download, DB_MSG, qrSvg,
} from "./core.js";
import { toCsv } from "./csv.js";

const $ = (s, r = document) => r.querySelector(s);
const pad2 = (n) => String(n).padStart(2, "0");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_LONG = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ZONES = [
  "GMT+05:30 · Kolkata", "GMT+00:00 · London", "GMT+01:00 · Berlin",
  "GMT+04:00 · Dubai", "GMT+08:00 · Singapore", "GMT-05:00 · New York",
  "GMT-08:00 · Los Angeles",
];
// `?demo=1` renders bundled sample events for UI review only; it never writes to Firestore.
const DEMO = new URLSearchParams(location.search).has("demo");

const state = {
  user: null,
  events: null,
  rsvps: {},
  calMonth: new Date(),
  calDay: null,
  discoverQ: "",
  discoverKey: "",
  formFields: [],      // draft in the create/edit editor
  currentEvent: null,  // event behind the organiser member directory
  members: [],         // RSVP rows shown in the member directory
  memberQuery: "",
  myPass: null,        // { status, passToken } for the signed-in member (requestPass)
};
let mountNode = null;
let renderSeq = 0;
let modalCleanup = null;

// Matching firebase.js DEFAULT_FORM_FIELDS; used when an event has none stored.
const FALLBACK_FIELDS = [
  { key: "name", label: "Full name", type: "text", required: true, enabled: true },
  { key: "email", label: "Email", type: "email", required: true, enabled: true },
  { key: "phone", label: "Phone number", type: "tel", required: false, enabled: true },
  { key: "college", label: "College", type: "text", required: false, enabled: true },
];
const PRESET_KEYS = new Set(["name", "email", "phone", "college"]);
const INPUT_TYPES = ["text", "email", "tel", "number", "date", "url", "textarea"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const defaultFields = () => (fb.DEFAULT_FORM_FIELDS || FALLBACK_FIELDS).map((f) => ({ ...f }));

// ── small icons not shipped in core.js ──────────────────────────────────────
const ic = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const IX = {
  calendar: ic('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  grid: ic('<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>'),
  pin: ic('<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="2.5"/>'),
  clock: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  globe: ic('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>'),
  bell: ic('<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9z"/><path d="M10 21h4"/>'),
  caret: ic('<path d="m9 5 7 7-7 7"/>'),
  left: ic('<path d="m15 5-7 7 7 7"/>'),
  right: ic('<path d="m9 5 7 7-7 7"/>'),
  arrow: ic('<path d="M4 12h15M13 6l6 6-6 6"/>'),
  edit: ic('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>'),
  search: ic('<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>'),
  spark: ic('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.8 2.8M15.2 15.2 18 18M18 6l-2.8 2.8M8.8 15.2 6 18"/>'),
  close: ic('<path d="M6 6l12 12M18 6 6 18"/>'),
  share: ic('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>'),
  pass: ic('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 6v12M16 6v12"/>'),
};

// ── helpers ─────────────────────────────────────────────────────────────────
// core.artUrl() takes an index; v2 events store the art key as a string.
const coverUrl = (key, thumb = false) => {
  const i = ART.findIndex((a) => a.key === key);
  return artUrl(i < 0 ? 0 : i, thumb);
};
const artName = (key) => (ART.find((a) => a.key === key) || ART[0]).name;
const isFree = (v) => !String(v || "").trim() || /^free$/i.test(String(v).trim());
const priceLabel = (v) => (isFree(v) ? "Free" : `₹${String(v).replace(/^[₹$]/, "")}`);

function dateParts(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return {
    d,
    badge: `${MON[d.getMonth()]} ${pad2(d.getDate())}`.toUpperCase(),
    day: d.getDate(), month: d.getMonth(), year: d.getFullYear(),
    when: fmtWhen(d), time: fmtTime(d),
    dateInput: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    timeInput: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}
function defaultTimes() {
  const d = new Date(), e = new Date(d);
  d.setHours(18, 0, 0, 0);
  e.setHours(21, 0, 0, 0);
  return [dateParts(d), dateParts(e)];
}
function initials(name) {
  const s = String(name || "?").trim();
  return s ? s[0].toUpperCase() : "?";
}
function avatarStack(list = [], max = 5) {
  if (!list.length) return "";
  const av = list.slice(0, max).map((r) =>
    `<span class="l-av" title="${esc(r.name || r.email || "Guest")}">${esc(initials(r.name || r.email))}</span>`).join("");
  const more = list.length > max ? `<span class="l-av l-av-more">+${list.length - max}</span>` : "";
  return `<span class="l-avatars">${av}${more}</span>`;
}
function currentRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("calendar")) return "calendar";
  if (h.startsWith("discover")) return "discover";
  if (h.startsWith("create")) return "create";
  if (h.startsWith("event/")) return "event";
  return "feed";
}
function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}
function invalidate() { state.events = null; state.rsvps = {}; }

// ── registration field helpers ──────────────────────────────────────────────
function fieldSlug(label) {
  return String(label || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
}
function uniqueFieldKey(base, fields) {
  let key = base, n = 2;
  while (fields.some((f) => f.key === key)) key = `${base}_${n++}`;
  return key;
}
function enabledFormFields(ev) {
  const src = ev?.formFields?.length ? ev.formFields : defaultFields();
  return src.filter((f) => f && f.key && f.enabled !== false);
}
// RSVP docs store answers plus mapped preset columns; accept either shape.
function memberValue(member, field) {
  const v = member?.answers?.[field.key] ?? member?.[field.key] ?? "";
  return v == null ? "" : String(v);
}
function joinedLabel(member) {
  const raw = member?.at || member?.createdAt;
  if (!raw) return "—";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "—" : fmtWhen(d);
}

// ── preview data (only when ?demo=1) ────────────────────────────────────────
function demoEvents() {
  const now = new Date();
  const at = (days, h, m = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  return [
    { id: "demo-1", title: "Midnight Frequencies", cover: "dj", startsAt: at(2, 19), endsAt: at(2, 23, 30), location: "The Warehouse, Indiranagar", description: "Three DJs, one room, no setlist. Bass from 7pm till close. Bring your people.", price: "Free", approval: false, capacity: 0, visibility: "public", ownerId: "demo" },
    { id: "demo-2", title: "Open Mic & Open Hearts", cover: "mic", startsAt: at(4, 18, 30), endsAt: at(4, 21), location: "The Reading Room, Koramangala", description: "Poetry, stories and songs. Sign up on the door — five minutes each, all voices welcome.", price: "Free", approval: false, capacity: 60, visibility: "public", ownerId: "demo" },
    { id: "demo-3", title: "Salsa Under the Stars", cover: "dance", startsAt: at(6, 19, 30), endsAt: at(6, 22), location: "Rooftop 21, MG Road", description: "Beginner-friendly salsa night. No partner needed, just comfortable shoes.", price: "300", approval: false, capacity: 0, visibility: "public", ownerId: "demo" },
    { id: "demo-4", title: "Indie Live: Paper Planes", cover: "band", startsAt: at(9, 20), endsAt: at(9, 23), location: "The Courtyard, HSR", description: "An evening of original music with Paper Planes and friends. Doors at 7.", price: "499", approval: false, capacity: 180, visibility: "public", ownerId: "demo" },
    { id: "demo-5", title: "Build & Breakfast Hack Jam", cover: "hack", startsAt: at(12, 9), endsAt: at(12, 17), location: "Foundry Workspace, Whitefield", description: "A day of building small, useful things. Coffee and breakfast on us. Bring a laptop.", price: "Free", approval: true, capacity: 40, visibility: "public", ownerId: "demo" },
    { id: "demo-6", title: "Sunday Rooftop Social", cover: "crowd", startsAt: at(15, 16), endsAt: at(15, 20), location: "Skybar, Indiranagar", description: "Slow afternoon, good music, better company. Everyone is welcome.", price: "Free", approval: false, capacity: 0, visibility: "public", ownerId: "demo" },
  ];
}
const DEMO_NAMES = ["Aarav S.", "Meera K.", "Rohan D.", "Isha P.", "Nikhil R.", "Tara M.", "Dev A."];
function demoRsvps(id) {
  const n = (Number(id.replace(/\D/g, "")) % 4) + 3;
  return DEMO_NAMES.slice(0, n).map((name, i) => ({ uid: `demo-${i}`, name, email: "", at: null }));
}

async function loadEvents() {
  if (DEMO) state.events = state.events || demoEvents();
  if (!state.events) {
    try {
      state.events = await fb.listV2Events();
    } catch (e) {
      console.warn("listV2Events failed", e);
      state.events = [];
    }
  }
  // Attach RSVP counts once so every view (feed, calendar, discover) shares them.
  await Promise.all(state.events.map(async (e) => { e._rsvps = await rsvpsFor(e.id); }));
  return state.events;
}
// `event` defaults to the event on screen (state.currentEvent). The detail
// view passes the event it just loaded so the owner check is made against the
// right event even before state.currentEvent is swapped in.
async function rsvpsFor(id, event = state.currentEvent) {
  if (DEMO) return (state.rsvps[id] = state.rsvps[id] || demoRsvps(id));
  if (state.rsvps[id]) return state.rsvps[id];
  // Full RSVP rows carry contact details and are owner-only. Everyone else —
  // including private-link visitors — uses the world-readable, name-only
  // projection so avatars and going counts still work.
  const owner = !!state.user && event?.id === id && event.ownerId === state.user.uid;
  try {
    const rows = owner ? await fb.listRsvps(id) : await fb.listPublicMembers(id);
    state.rsvps[id] = owner ? rows : rows.map((m) => ({ uid: m.uid, name: m.name || "" }));
  } catch (e) {
    console.warn(owner ? "listRsvps failed" : "listPublicMembers failed", e);
    state.rsvps[id] = [];
  }
  return state.rsvps[id];
}

// ── nav ─────────────────────────────────────────────────────────────────────
const navLink = (href, label, routeName) =>
  `<a class="l-link ${currentRoute() === routeName ? "is-active" : ""}" href="${href}">${IX[routeName === "calendar" ? "calendar" : routeName === "discover" ? "search" : "grid"]}<span>${label}</span></a>`;

function navHTML() {
  const label = state.user?.displayName || state.user?.email || "Your account";
  return `
  <header class="l-nav">
    <div class="l-nav-inner">
      <div class="l-nav-left">
        <a class="l-brand" href="#/" aria-label="Home"><span class="l-brand-dot"></span><span class="l-brand-name">GatePass</span><span class="l-brand-mini">GP</span><span class="l-brand-sub">Events</span></a>
        <span class="l-nav-sep"></span>
        <nav class="l-links" aria-label="Primary">
          ${navLink("#/", "Events", "feed")}
          ${navLink("#/calendar", "Calendars", "calendar")}
          ${navLink("#/discover", "Discover", "discover")}
          <a class="l-link" href="organiser/">${IX.pass}<span>Organiser</span></a>
        </nav>
      </div>
      <div class="l-nav-right">
        <button class="l-icon-btn" data-action="clock" title="Local time" aria-label="Local time">${IX.clock}</button>
        <span class="l-clock" id="l-clock">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <button class="l-icon-btn" data-action="notify" title="Notifications" aria-label="Notifications">${IX.bell}</button>
        <button class="l-create" data-action="create">${I.plus}<span>Create Event</span></button>
        ${state.user
          ? `<button class="l-user" data-action="account" title="${esc(label)}" aria-label="Account"><span class="l-avatar">${esc(initials(label))}</span></button>`
          : `<button class="l-signin-nav" data-action="signin">${I.google}<span>Sign in</span></button>`}
      </div>
    </div>
  </header>`;
}
const skeleton = () => `
  <div class="l-skeleton-page">
    <div class="l-skeleton-line" style="width:140px"></div>
    <div class="l-skeleton-line" style="width:300px;height:28px"></div>
    <div class="l-skeleton-grid"><span></span><span></span><span></span><span></span><span></span><span></span></div>
  </div>`;

function setView(html) { const v = $("#l-view", mountNode); if (v) v.innerHTML = html; }

// ── auth ────────────────────────────────────────────────────────────────────
async function signedIn() {
  if (state.user) return state.user;
  try {
    await fb.signIn();
  } catch (e) {
    if (e?.code !== "auth/popup-closed-by-user" && e?.code !== "auth/cancelled-popup-request") {
      toast(e?.message || "Sign-in failed", "warnDot");
    }
    return null;
  }
  state.user = state.user || fb.auth?.currentUser || null;
  return state.user;
}
async function createGate() {
  const u = await signedIn();
  if (u) go("#/create");
}
function toggleAccountMenu() {
  $(".l-account-menu", mountNode)?.remove();
  const menu = document.createElement("div");
  menu.className = "l-account-menu";
  menu.innerHTML = `<div class="l-account-name">${esc(state.user?.displayName || state.user?.email || "Signed in")}</div>
    <button type="button" data-action="signout">Sign out</button>`;
  $(".l-nav-right", mountNode)?.append(menu);
}

// ── feed ────────────────────────────────────────────────────────────────────
function signinBanner() {
  if (state.user) return "";
  return `<div class="l-signin-banner">
    <div class="l-banner-text">
      <span class="l-banner-icon">${IX.spark}</span>
      <div><div class="l-banner-title">Browsing as a guest</div>
      <div class="l-banner-sub">Sign in to create events, RSVP and see who's going.</div></div>
    </div>
    <button class="l-google-btn" data-action="signin">${I.google}Sign in with Google</button>
  </div>`;
}
function cardHTML(e) {
  const p = dateParts(e.startsAt);
  const going = (e._rsvps || []).length;
  return `<a class="l-card" href="#/event/${encodeURIComponent(e.id)}">
    <div class="l-card-cover" style="background-image:url('${coverUrl(e.cover)}')">
      <span class="l-card-date">${esc(p ? p.badge : "TBA")}</span>
      <div class="l-card-overlay">
        <h3 class="l-card-title">${esc(e.title || "Untitled event")}</h3>
        <div class="l-card-meta">${IX.pin}<span>${esc(e.location || "Location to be announced")}</span></div>
      </div>
    </div>
    <div class="l-card-foot">
      <div class="l-going">${going
        ? `${avatarStack(e._rsvps)}<span>${going} going</span>`
        : `<span>Be the first to go</span>`}</div>
      <span class="l-price ${isFree(e.price) ? "is-free" : ""}">${esc(priceLabel(e.price))}</span>
    </div>
  </a>`;
}
const emptyCard = (title, text) => `<div class="l-empty">
  <span class="l-empty-icon">${IX.spark}</span><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;

async function renderFeed(seq) {
  const list = await loadEvents();
  if (renderSeq !== seq) return;
  setView(`${signinBanner()}
    <section class="l-page-head">
      <div><div class="l-eyebrow">What's happening</div><h1 class="l-h1">Events</h1>
      <p class="l-sub">Good things happen when you show up.</p></div>
      <span class="l-count-pill">${list.length} ${list.length === 1 ? "event" : "events"}</span>
    </section>
    ${list.length ? `<section class="l-grid">${list.map(cardHTML).join("")}</section>`
      : emptyCard("No events yet", "Be the first to put something on the calendar.")}`);
}

// ── calendar ────────────────────────────────────────────────────────────────
function calendarHTML(evs) {
  const first = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth(), 1);
  const offset = first.getDay();
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((offset + days) / 7) * 7;
  const byDay = new Map();
  for (const e of evs) {
    const p = dateParts(e.startsAt);
    if (!p || p.month !== first.getMonth() || p.year !== first.getFullYear()) continue;
    if (!byDay.has(p.day)) byDay.set(p.day, []);
    byDay.get(p.day).push(e);
  }
  const today = new Date();
  const dayCells = [];
  for (let i = 0; i < cells; i++) {
    const n = i - offset + 1;
    const d = new Date(first.getFullYear(), first.getMonth(), n);
    const inMonth = d.getMonth() === first.getMonth();
    const events = byDay.get(n) || [];
    const isToday = inMonth && d.toDateString() === today.toDateString();
    const selected = inMonth && state.calDay === n;
    dayCells.push(`<button class="l-cal-day ${inMonth ? "" : "is-out"} ${isToday ? "is-today" : ""} ${selected ? "is-selected" : ""}"
      data-action="cal-day" data-day="${inMonth ? n : ""}" data-out="${inMonth ? "0" : "1"}"
      aria-label="${esc(MON_LONG[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear())}">
      <span class="l-cal-num">${d.getDate()}</span>
      ${events.length ? `<span class="l-cal-dots">${events.slice(0, 3).map(() => `<span class="l-cal-dot"></span>`).join("")}</span>` : ""}
      ${events.length ? `<span class="l-cal-labels">${events.slice(0, 2).map((e) => `<span class="l-cal-evlabel">${esc(e.title)}</span>`).join("")}</span>` : ""}
    </button>`);
  }
  const shown = state.calDay ? evs.filter((e) => {
    const p = dateParts(e.startsAt);
    return p && p.day === state.calDay && p.month === first.getMonth() && p.year === first.getFullYear();
  }) : evs.filter((e) => {
    const p = dateParts(e.startsAt);
    return p && p.month === first.getMonth() && p.year === first.getFullYear();
  });
  const heading = state.calDay
    ? `Events on ${MON_LONG[first.getMonth()]} ${state.calDay}`
    : `Events in ${MON_LONG[first.getMonth()]}`;
  return `<div class="l-cal">
    <div class="l-cal-top">
      <h2 class="l-cal-month">${MON_LONG[first.getMonth()]} ${first.getFullYear()}</h2>
      <div class="l-cal-nav">
        <button data-action="cal-prev" aria-label="Previous month">${IX.left}</button>
        <button data-action="cal-today">Today</button>
        <button data-action="cal-next" aria-label="Next month">${IX.right}</button>
      </div>
    </div>
    <div class="l-cal-grid">
      <div class="l-cal-dow">${DOW.map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="l-cal-days">${dayCells.join("")}</div>
    </div>
    <section class="l-cal-results">
      <h3>${esc(heading)}</h3>
      ${shown.length ? `<div class="l-grid l-grid-small">${shown.map(cardHTML).join("")}</div>`
        : emptyCard("Nothing on the calendar", "Pick another day or create an event.")}
    </section>
  </div>`;
}
async function renderCalendar(seq) {
  const evs = await loadEvents();
  if (renderSeq !== seq) return;
  setView(`<section class="l-page-head">
      <div><div class="l-eyebrow">Plan ahead</div><h1 class="l-h1">Calendars</h1>
      <p class="l-sub">Every event, one month at a time.</p></div></section>
    ${calendarHTML(evs)}`);
}

// ── discover ────────────────────────────────────────────────────────────────
function discoverResults() {
  const q = state.discoverQ.trim().toLowerCase();
  const list = (state.events || []).filter((e) => {
    const keyOk = !state.discoverKey || e.cover === state.discoverKey;
    const hay = [e.title, e.location, e.description, artName(e.cover)].join(" ").toLowerCase();
    return keyOk && (!q || hay.includes(q));
  });
  return list.length
    ? `<div class="l-grid">${list.map(cardHTML).join("")}</div>`
    : emptyCard("No matches found", "Try another search or clear the filters.");
}
function refreshDiscover() {
  const box = $("#l-discover-results", mountNode);
  if (box) box.innerHTML = discoverResults();
  mountNode.querySelectorAll(".l-chip").forEach((c) =>
    c.classList.toggle("is-active", c.dataset.key === state.discoverKey));
}
async function renderDiscover(seq) {
  const evs = await loadEvents();
  if (renderSeq !== seq) return;
  const chips = [{ key: "", name: "All events" }, ...ART].map((a) =>
    `<button class="l-chip ${state.discoverKey === a.key ? "is-active" : ""}" data-action="chip" data-key="${esc(a.key)}">
      ${a.key ? `<span class="l-chip-dot" style="background:${chipColor(a.key)}"></span>` : ""}${esc(a.name)}</button>`).join("");
  setView(`<section class="l-page-head">
      <div><div class="l-eyebrow">Find your people</div><h1 class="l-h1">Discover</h1>
      <p class="l-sub">Search by anything — a name, a place, a feeling.</p></div></section>
    <div class="l-search-wrap">${IX.search}<input id="l-search" class="l-search" type="search" autocomplete="off"
      placeholder="Search events, places, people…" value="${esc(state.discoverQ)}" aria-label="Search events"></div>
    <div class="l-chips">${chips}</div>
    <div id="l-discover-results">${discoverResults()}</div>`);
}
function chipColor(key) {
  return ({ crowd: "#E85C9A", dj: "#8B6FE8", mic: "#E8A85C", dance: "#5CC7E8", band: "#E87C5C", hack: "#6FE8A0" })[key] || "#E85C9A";
}

// ── create / edit ───────────────────────────────────────────────────────────
function fieldsHTML() {
  return state.formFields.map((f, i) => {
    const preset = PRESET_KEYS.has(f.key);
    return `<div class="l-field-row" data-index="${i}">
      <label class="l-field-check" title="Include on the RSVP form">
        <input type="checkbox" class="f-enabled" ${f.enabled !== false ? "checked" : ""}
          aria-label="Include ${esc(f.label || f.key)}">
      </label>
      <input type="text" class="l-field-label" value="${esc(f.label || "")}" maxlength="60"
        placeholder="Field label" aria-label="Label for ${esc(f.label || f.key)}">
      <label class="l-field-req" title="Guests must fill this in">
        <input type="checkbox" class="f-required" ${f.required ? "checked" : ""}
          aria-label="Make ${esc(f.label || f.key)} required"><span>Required</span>
      </label>
      <span class="l-field-key ${preset ? "is-preset" : ""}" title="Field key: ${esc(f.key)}">${esc(f.key)}</span>
      ${preset ? `<span class="l-field-key-space"></span>`
        : `<button type="button" class="l-field-remove" data-action="field-remove" data-index="${i}"
            aria-label="Remove ${esc(f.label || f.key)}" title="Remove field">${IX.close}</button>`}
    </div>`;
  }).join("");
}
function syncFieldsFromDOM() {
  const root = $("#l-fields", mountNode);
  if (!root) return;
  root.querySelectorAll(".l-field-row").forEach((row) => {
    const f = state.formFields[Number(row.dataset.index)];
    if (!f) return;
    f.enabled = !!$(".f-enabled", row)?.checked;
    f.required = !!$(".f-required", row)?.checked;
    const label = String($(".l-field-label", row)?.value || "").trim();
    if (label) f.label = label;
  });
}
function renderFieldsUI() {
  const root = $("#l-fields", mountNode);
  if (root) root.innerHTML = fieldsHTML();
}
function addFormField() {
  syncFieldsFromDOM();
  const input = $("#l-new-field-label", mountNode);
  const label = String(input?.value || "").trim();
  if (!label) { input?.focus(); toast("Give the new field a label"); return; }
  state.formFields.push({
    key: uniqueFieldKey(fieldSlug(label), state.formFields),
    label, type: "text", required: false, enabled: true,
  });
  input.value = "";
  renderFieldsUI();
  input.focus();
}
function removeFormField(index) {
  syncFieldsFromDOM();
  if (!Number.isInteger(index) || index < 0 || index >= state.formFields.length) return;
  state.formFields.splice(index, 1);
  renderFieldsUI();
}

function createHTML(ev) {
  const [ds, de] = defaultTimes();
  const p = ev ? (dateParts(ev.startsAt) || ds) : ds;
  const pe = ev ? (dateParts(ev.endsAt) || de) : de;
  const cover = ev?.cover || "crowd";
  const zones = [...ZONES];
  const tz = ev?.timezone || ZONES[0];
  if (tz && !zones.includes(tz)) zones.unshift(tz);
  const price = isFree(ev?.price) ? "" : String(ev?.price || "").replace(/^[₹$]/, "");
  return `<div class="l-crumb"><a href="#/">Events</a>${IX.caret}<span>${ev ? "Edit event" : "New event"}</span></div>
  <div class="l-editor-head">
    <h1 class="l-h1">${ev ? "Edit your event" : "Create an event"}</h1>
    <p class="l-sub">${ev ? "Update the details below." : "A few details and you're ready to invite people."}</p>
  </div>
  <form id="l-create-form" class="l-editor" data-id="${esc(ev?.id || "")}" novalidate>
    <aside class="l-editor-left">
      <div class="l-cover-card">
        <div class="l-cover-preview" id="l-cover-preview" style="background-image:url('${coverUrl(cover)}')">
          <span class="l-cover-tag">Cover</span>
        </div>
        <div class="l-theme-bar">
          <div><div class="l-theme-label">Theme</div><div class="l-theme-name"><span class="l-swatch"></span>Minimal</div></div>
          <span class="l-theme-hint">Live preview</span>
        </div>
      </div>
      <div class="l-picker-label">Choose a cover</div>
      <div class="l-art-picker">
        ${ART.map((a) => `<button type="button" class="l-art-thumb ${a.key === cover ? "is-active" : ""}"
          data-action="art" data-key="${a.key}" style="background-image:url('${coverUrl(a.key, true)}')"
          title="${esc(a.name)}" aria-label="${esc(a.name)}"></button>`).join("")}
      </div>
      <p class="l-help">Six covers to choose from. You can change this any time.</p>
    </aside>
    <div class="l-editor-right">
      <input type="hidden" name="cover" id="l-cover-input" value="${esc(cover)}">
      <label class="l-title-label" for="l-title">Event Name</label>
      <input id="l-title" name="title" class="l-title-input" maxlength="120" placeholder="Event Name"
        value="${esc(ev?.title || "")}" autocomplete="off">

      <div class="l-dt-row">
        <span class="l-dt-label">Start</span>
        <input type="date" name="startDate" value="${esc(p.dateInput)}" aria-label="Start date">
        <input type="time" name="startTime" value="${esc(p.timeInput)}" aria-label="Start time">
      </div>
      <div class="l-dt-row">
        <span class="l-dt-label">End</span>
        <input type="date" name="endDate" value="${esc(pe.dateInput)}" aria-label="End date">
        <input type="time" name="endTime" value="${esc(pe.timeInput)}" aria-label="End time">
      </div>
      <div class="l-tz-row">
        <span class="l-dt-label">Timezone</span>
        <label class="l-tz-chip">${IX.globe}<select name="timezone" aria-label="Timezone">
          ${zones.map((z) => `<option value="${esc(z)}" ${z === tz ? "selected" : ""}>${esc(z)}</option>`).join("")}
        </select></label>
      </div>

      <hr class="l-divider">
      <div class="l-field">
        <label class="l-label" for="l-location">Location</label>
        <div class="l-input-icon">${IX.pin}<input id="l-location" name="location" class="l-input"
          placeholder="Add a venue or link" value="${esc(ev?.location || "")}"></div>
      </div>
      <div class="l-field">
        <label class="l-label" for="l-desc">Description</label>
        <textarea id="l-desc" name="description" class="l-textarea"
          placeholder="What's this event about?">${esc(ev?.description || "")}</textarea>
      </div>

      <h2 class="l-section-title">Event Options</h2>
      <div class="l-option">
        <div class="l-option-text"><strong>Ticket Price</strong><span>Leave blank to keep it free</span></div>
        <div class="l-price-control"><span>₹</span><input name="price" class="l-mini-input" placeholder="Free" value="${esc(price)}" inputmode="numeric"></div>
      </div>
      <div class="l-option">
        <div class="l-option-text"><strong>Require Approval</strong><span>Review guests before they join</span></div>
        <label class="l-switch"><input type="checkbox" name="approval" ${ev?.approval ? "checked" : ""}><span class="l-switch-track"></span></label>
      </div>
      <div class="l-option">
        <div class="l-option-text"><strong>Capacity</strong><span>Limit how many can come</span></div>
        <input name="capacity" type="number" min="0" class="l-mini-input" placeholder="Unlimited"
          value="${ev?.capacity ? esc(ev.capacity) : ""}">
      </div>
      <div class="l-option">
        <div class="l-option-text"><strong>Visibility</strong><span>Public events appear in Discover</span></div>
        <div class="l-seg">
          <label><input type="radio" name="visibility" value="public" ${ev?.visibility !== "private" ? "checked" : ""}><span>Public</span></label>
          <label><input type="radio" name="visibility" value="private" ${ev?.visibility === "private" ? "checked" : ""}><span>Private</span></label>
        </div>
      </div>

      <h2 class="l-section-title">Registration fields</h2>
      <p class="l-help">Pick the details guests fill in when they RSVP. Untick a field to leave it out.</p>
      <div class="l-fields" id="l-fields">${fieldsHTML()}</div>
      <div class="l-field-add">
        <input id="l-new-field-label" class="l-input" maxlength="60" autocomplete="off"
          placeholder="New field label (e.g. Year)" aria-label="New field label">
        <button type="button" class="l-outline" data-action="field-add">Add field</button>
      </div>

      <p class="l-error" id="l-error" role="alert" hidden></p>
      <div class="l-actions">
        <a href="#/" class="l-cancel">Cancel</a>
        <button type="submit" class="l-primary">${ev ? "Save changes" : "Create Event"}${IX.arrow}</button>
      </div>
    </div>
  </form>`;
}
function showError(el, msg) { if (el) { el.textContent = msg; el.hidden = false; } }
async function renderCreate(id, seq) {
  if (!state.user) {
    const u = await signedIn();
    if (renderSeq !== seq) return;
    if (!u) { go("#/"); return; }
  }
  let ev = null;
  if (id) {
    try { ev = DEMO ? demoEvents().find((x) => x.id === id) : await fb.getV2Event(id); }
    catch (e) { toast(DB_MSG, "warnDot"); }
  }
  if (renderSeq !== seq) return;
  if (id && !ev) {
    setView(`<div class="l-notice"><h1>Event not found</h1><p>This event may have been removed.</p>
      <a href="#/">Back to events</a></div>`);
  } else if (id && ev.ownerId !== state.user?.uid) {
    setView(`<div class="l-notice"><h1>You can't edit this event</h1><p>Only the host can make changes.</p>
      <a href="#/${"event/" + encodeURIComponent(id)}">Back to the event</a></div>`);
  } else {
    const stored = ev?.formFields?.length ? ev.formFields : defaultFields();
    state.formFields = stored.map((f) => ({ ...f }));
    setView(createHTML(ev));
  }
}
async function onSubmit(e) {
  const form = e.target;
  if (form.id !== "l-create-form") return;
  e.preventDefault();
  if (DEMO) { toast("Demo mode — changes aren't saved"); return; }
  const f = form.elements;
  const err = $("#l-error", form);
  err.hidden = true;
  syncFieldsFromDOM();
  const title = String(f.namedItem("title")?.value || "").trim();
  const start = new Date(`${f.namedItem("startDate")?.value}T${f.namedItem("startTime")?.value || "00:00"}`);
  const end = new Date(`${f.namedItem("endDate")?.value}T${f.namedItem("endTime")?.value || "00:00"}`);
  if (!title) return showError(err, "Give your event a name.");
  if (Number.isNaN(start.getTime())) return showError(err, "Choose a valid start date and time.");
  if (Number.isNaN(end.getTime())) return showError(err, "Choose a valid end date and time.");
  if (end <= start) return showError(err, "The end must be after the start.");
  const row = {
    title, cover: f.namedItem("cover")?.value || "crowd",
    startsAt: start.toISOString(), endsAt: end.toISOString(),
    timezone: f.namedItem("timezone")?.value || ZONES[0],
    location: String(f.namedItem("location")?.value || "").trim(),
    description: String(f.namedItem("description")?.value || "").trim(),
    price: String(f.namedItem("price")?.value || "").trim() || "Free",
    approval: !!f.namedItem("approval")?.checked,
    capacity: Number(f.namedItem("capacity")?.value) || 0,
    visibility: f.namedItem("visibility")?.value || "public",
    formFields: state.formFields.filter((field) => field.enabled).map((field) => ({
      ...field,
      label: String(field.label || field.key).trim() || field.key,
    })),
  };
  const btn = form.querySelector('[type="submit"]');
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const editing = !!form.dataset.id;
    const id = editing ? (await fb.updateV2Event(form.dataset.id, row), form.dataset.id)
      : await fb.createV2Event(row);
    invalidate();
    toast(editing ? "Event updated" : "Event created", "check");
    location.hash = `#/event/${id}`;
  } catch (ex) {
    console.error(ex);
    showError(err, ex?.message || DB_MSG);
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

// ── detail + RSVP ───────────────────────────────────────────────────────────
function statusPill(status) {
  const s = status || "approved";
  const label = s === "pending" ? "Pending" : s === "rejected" ? "Rejected" : "Approved";
  return `<span class="l-status-pill is-${esc(s)}">${esc(label)}</span>`;
}
function passStatusHTML(pass) {
  if (!pass || !pass.status) return "";
  if (pass.status === "pending") {
    return `<div class="l-status-banner is-pending">${IX.clock}<span>Awaiting approval</span></div>`;
  }
  if (pass.status === "rejected") {
    return `<div class="l-status-banner is-rejected">${IX.close}<span>Request wasn't approved — update and resubmit</span></div>`;
  }
  if (pass.passToken) {
    const url = passUrl(pass.passToken);
    const checked = pass.checkedInAt
      ? `<div class="l-status-banner is-approved">${I.check}<span>Checked in · ${esc(fmtTime(pass.checkedInAt))}${pass.checkedGate ? ` · ${esc(pass.checkedGate)}` : ""}</span></div>`
      : "";
    return `${checked}<a class="l-pass-link" href="${esc(url)}" target="_blank" rel="noopener">
      ${IX.pass}<span>Open my pass</span>${IX.arrow}</a>
    <div class="l-qr-card">
      <div class="l-qr-frame">${qrSvg(url, { fg: "#12121C", margin: 2 })}</div>
      <p>Show this QR at the gate</p>
      <a class="l-qr-open" href="${esc(url)}" target="_blank" rel="noopener">Open full pass</a>
    </div>`;
  }
  return `<div class="l-status-banner is-approved">${I.check}<span>You're approved</span></div>`;
}
function gatePanelHTML(ev) {
  if (!ev.gate_code) return "";
  return `<div class="l-gate-panel">
    <div class="l-gate-label">Your gate code</div>
    <div class="l-gate-code">${esc(fmtCode(ev.gate_code))}</div>
    <button type="button" class="l-outline l-gate-copy" data-action="copy-gate">${I.link}<span>Copy gate link</span></button>
  </div>`;
}
function detailHTML(ev, rsvps, mine, owner, full, myPass) {
  const p = dateParts(ev.startsAt);
  const pe = dateParts(ev.endsAt);
  const when = p ? `${p.when}${pe ? " → " + pe.time : ""}` : "Date to be announced";
  let cta;
  if (!state.user) {
    cta = `<button class="l-google-btn l-block" data-action="signin">${I.google} Sign in to RSVP</button>`;
  } else if (owner) {
    cta = `<div class="l-owner-actions">
      <button class="l-primary l-block" data-action="edit" data-id="${esc(ev.id)}">${IX.edit} Edit event</button>
      <a class="l-outline l-block" href="organiser/#/e/${esc(ev.id)}">${IX.pass} Passes &amp; gate tools</a>
      <button class="l-danger l-block" data-action="delete" data-id="${esc(ev.id)}">${I.trash} Delete event</button>
    </div>`;
  } else if (mine) {
    cta = `<div class="l-rsvp-actions">
      ${passStatusHTML(myPass)}
      <button class="l-primary l-block" data-action="edit-rsvp" data-id="${esc(ev.id)}">${IX.edit} Edit my details</button>
      <button class="l-outline l-block" data-action="cancel-rsvp" data-id="${esc(ev.id)}">Cancel RSVP</button>
    </div>`;
  } else {
    cta = `<button class="l-primary l-block" data-action="rsvp" data-id="${esc(ev.id)}" ${full ? "disabled" : ""}>
      ${full ? "Event is full" : ev.approval ? "Request to attend" : "RSVP"}${full ? "" : IX.arrow}</button>`;
  }
  return `<div class="l-crumb"><a href="#/">Events</a>${IX.caret}<span>${esc(ev.title)}</span></div>
  <div class="l-detail">
    <div class="l-detail-cover" style="background-image:url('${coverUrl(ev.cover)}')"></div>
    <div class="l-detail-grid">
      <div class="l-detail-main">
        <div class="l-detail-headrow">
          <div class="l-detail-kicker">${esc(artName(ev.cover))} · ${ev.visibility === "private" ? "Private" : "Public"}</div>
          <button type="button" class="l-share-btn" data-action="share" title="Share this event" aria-label="Share this event">${IX.share}<span>Share</span></button>
        </div>
        <h1 class="l-detail-title">${esc(ev.title || "Untitled event")}</h1>
        <div class="l-detail-facts">
          <div>${IX.calendar}<span>${esc(when)}</span></div>
          <div>${IX.clock}<span>${esc(ev.timezone || "Local time")}</span></div>
          <div>${IX.pin}<span>${esc(ev.location || "Location to be announced")}</span></div>
        </div>
        <hr class="l-divider">
        <h2 class="l-detail-h2">About this event</h2>
        <div class="l-detail-desc">${esc(ev.description || "No description yet.")}</div>
        ${ev.approval ? `<div class="l-note">${I.check} Requests need the host's approval.</div>` : ""}
        ${!isFree(ev.price) ? `<div class="l-note">${I.ticket} Tickets: ${esc(priceLabel(ev.price))}</div>` : ""}
      </div>
      <aside class="l-rsvp-card">
        <div class="l-rsvp-top"><strong>${rsvps.length} going</strong><span class="l-going-dot"></span></div>
        ${avatarStack(rsvps, 6)}
        ${owner ? gatePanelHTML(ev) : ""}
        ${owner ? `<div class="l-owner-note">You're hosting this event</div>` : ""}
        ${cta}
        ${ev.capacity ? `<p class="l-cap-note">${rsvps.length} of ${ev.capacity} spots taken</p>` : ""}
      </aside>
    </div>
  </div>
  ${owner ? `<section class="l-members" id="l-members" aria-label="Members"></section>` : ""}`;
}
async function renderEvent(id, seq) {
  let ev = null;
  try { ev = DEMO ? demoEvents().find((x) => x.id === id) : await fb.getV2Event(id); }
  catch (e) { console.warn("getV2Event failed", e); }
  if (renderSeq !== seq) return;
  if (!ev) {
    setView(`<div class="l-notice"><h1>Event not found</h1><p>This event may have been removed.</p>
      <a href="#/">Back to events</a></div>`);
    return;
  }
  const rsvps = await rsvpsFor(id, ev);
  if (renderSeq !== seq) return;
  const mine = !!state.user && rsvps.some((r) => r.uid === state.user.uid);
  const owner = !!state.user && ev.ownerId === state.user.uid;
  const full = ev.capacity > 0 && rsvps.length >= ev.capacity && !mine;
  // The member list deliberately hides passToken, so read the signed-in member's
  // own RSVP directly for their approval state / pass link.
  let myPass = null;
  if (mine && !owner) {
    if (DEMO) {
      myPass = ev.approval ? { status: "pending", passToken: null } : { status: "approved", passToken: null };
    } else {
      try { myPass = await fb.requestPass(id); }
      catch (e) { console.warn("requestPass failed", e); }
      // If the gate has already scanned this member in, say so right here —
      // the stamp lives on the public pass doc, readable with the token.
      if (myPass?.passToken) {
        try {
          const pub = await fb.getPassByToken(myPass.passToken);
          if (pub?.checked_in_at) {
            myPass = { ...myPass, checkedInAt: pub.checked_in_at, checkedGate: pub.gate || "" };
          }
        } catch (e) { console.warn("pass stamp check failed", e); }
      }
    }
  }
  if (renderSeq !== seq) return;
  state.myPass = myPass;
  if (state.currentEvent?.id !== id) state.memberQuery = "";
  state.currentEvent = ev;
  state.members = rsvps;
  setView(detailHTML(ev, rsvps, mine, owner, full, myPass));
  if (owner) renderMembers();
}

// Re-render just the detail view after a write so the fresh RSVP list (and any
// search text) survives — a full route() would clear the cache and the search.
async function refreshEventView(id) {
  await renderEvent(id, renderSeq);
}

// ── RSVP modal ──────────────────────────────────────────────────────────────
function closeRsvpForm() {
  if (!modalCleanup) return;
  const cleanup = modalCleanup;
  modalCleanup = null;
  cleanup();
}
function answerFor(field, existing) {
  const a = existing?.answers || {};
  let v = a[field.key];
  if ((v === undefined || v === null || v === "") && PRESET_KEYS.has(field.key)) {
    v = existing?.[field.key];
  }
  if ((v === undefined || v === null || v === "") && !existing) {
    if (field.key === "name") v = state.user?.displayName || "";
    if (field.key === "email") v = state.user?.email || "";
  }
  return v == null ? "" : String(v);
}
function rsvpInputHTML(field, existing) {
  const type = INPUT_TYPES.includes(field.type) ? field.type : "text";
  const id = `l-rsvp-${esc(field.key)}`;
  const label = esc(field.label || field.key);
  const required = field.required ? ' required aria-required="true"' : "";
  const star = field.required ? ' <span class="l-req">*</span>' : "";
  const common = `id="${id}" data-key="${esc(field.key)}" class="l-input"${required}`;
  const value = esc(answerFor(field, existing));
  if (type === "textarea") {
    return `<div class="l-modal-field"><label class="l-label" for="${id}">${label}${star}</label>
      <textarea ${common} rows="3">${value}</textarea></div>`;
  }
  const auto = field.key === "name" ? "name" : field.key === "email" ? "email"
    : field.key === "phone" ? "tel" : "off";
  return `<div class="l-modal-field"><label class="l-label" for="${id}">${label}${star}</label>
    <input ${common} type="${type}" autocomplete="${auto}" value="${value}"></div>`;
}
function openRsvpForm(ev, existing = null, ownerMode = false) {
  closeRsvpForm();
  const fields = enabledFormFields(ev);
  const overlay = document.createElement("div");
  overlay.className = "l-modal-overlay";
  overlay.innerHTML = `
    <div class="l-modal" role="dialog" aria-modal="true" aria-labelledby="l-rsvp-title">
      <div class="l-modal-head">
        <div>
          <div class="l-eyebrow">${ownerMode ? "Guest details" : "RSVP"}</div>
          <h2 class="l-modal-title" id="l-rsvp-title">${ownerMode ? "Edit member" : esc(ev.title || "Event")}</h2>
          <p class="l-modal-sub">${ownerMode
            ? "Update the details stored for this guest."
            : existing ? "Update your details for this event." : "Fill in your details to join this event."}</p>
        </div>
        <button type="button" class="l-modal-close" data-close-modal aria-label="Close">${IX.close}</button>
      </div>
      <form id="l-rsvp-form" novalidate>
        <div class="l-modal-body">
          ${fields.length ? fields.map((f) => rsvpInputHTML(f, existing)).join("")
            : `<p class="l-help">This event doesn't ask for any extra details.</p>`}
        </div>
        <p class="l-error l-modal-error" data-modal-error role="alert" hidden></p>
        <div class="l-actions l-modal-actions">
          <button type="button" class="l-cancel" data-close-modal>Cancel</button>
          <button type="submit" class="l-primary">${ownerMode ? "Save changes" : "Submit RSVP"}${IX.arrow}</button>
        </div>
      </form>
    </div>`;
  document.body.append(overlay);
  const form = $("#l-rsvp-form", overlay);
  const err = $("[data-modal-error]", overlay);
  const btn = form.querySelector('[type="submit"]');
  const btnHTML = btn.innerHTML;

  const onKey = (e) => { if (e.key === "Escape") closeRsvpForm(); };
  modalCleanup = () => { document.removeEventListener("keydown", onKey); overlay.remove(); };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest("[data-close-modal]")) closeRsvpForm();
  });
  document.addEventListener("keydown", onKey);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const answers = {};
    let firstBad = null;
    for (const input of form.querySelectorAll("[data-key]")) {
      const key = input.dataset.key;
      const field = fields.find((f) => f.key === key) || {};
      const value = String(input.value || "").trim();
      input.classList.remove("is-invalid");
      if (field.required && !value) { input.classList.add("is-invalid"); firstBad = firstBad || input; }
      if (field.type === "email" && value && !EMAIL_RE.test(value)) {
        input.classList.add("is-invalid"); firstBad = firstBad || input;
      }
      answers[key] = value;
    }
    if (firstBad) {
      showError(err, "Please complete the highlighted fields before continuing.");
      firstBad.focus();
      return;
    }

    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      if (DEMO) {
        const uid = existing?.uid || (ownerMode ? "demo-member" : state.user?.uid) || "demo-you";
        const merged = { ...(existing || {}), uid, answers };
        for (const key of PRESET_KEYS) merged[key] = answers[key] ?? merged[key] ?? "";
        const list = [...(state.rsvps[ev.id] || [])];
        const at = list.findIndex((r) => r.uid === uid);
        if (at >= 0) list[at] = merged;
        else list.push(merged);
        state.rsvps[ev.id] = list;
      } else if (existing) {
        const uid = existing.uid || state.user?.uid;
        if (!uid) throw new Error("Sign in required");
        if (!ownerMode && existing.status === "rejected") {
          // A rejected approval request is resubmitted as a fresh pending request.
          const u = await signedIn();
          if (!u) { btn.disabled = false; btn.innerHTML = btnHTML; return; }
          await fb.rsvpEvent(ev.id, u, answers);
        } else {
          await fb.updateRsvp(ev.id, uid, answers);
        }
        // The next render re-reads through rsvpsFor(), which picks the source
        // allowed for this viewer (owner list vs. public projection).
        delete state.rsvps[ev.id];
      } else {
        const u = await signedIn();
        if (!u) {
          btn.disabled = false; btn.innerHTML = btnHTML;
          return;
        }
        await fb.rsvpEvent(ev.id, u, answers);
        delete state.rsvps[ev.id];
      }
      closeRsvpForm();
      let message = ownerMode ? "Member updated" : existing ? "Details updated" : "You're going!";
      if (!ownerMode && !DEMO) {
        try {
          const pass = await fb.requestPass(ev.id);
          state.myPass = pass;
          if (pass.status === "pending") message = existing ? "Request resubmitted — awaiting approval" : "Request sent — awaiting approval";
          else if (pass.status === "rejected") message = "Request wasn't approved";
        } catch {}
      }
      toast(message, "check");
      await refreshEventView(ev.id);
    } catch (ex) {
      console.error(ex);
      showError(err, ex?.message || DB_MSG);
      btn.disabled = false;
      btn.innerHTML = btnHTML;
    }
  });
  requestAnimationFrame(() => form.querySelector("[data-key]")?.focus());
}
async function openRsvpFor(id) {
  const u = await signedIn();
  if (!u) return;
  let ev = DEMO ? demoEvents().find((e) => e.id === id) : (state.events || []).find((e) => e.id === id);
  if (!ev && !DEMO) { try { ev = await fb.getV2Event(id); } catch {} }
  if (!ev) return;
  const rsvps = await rsvpsFor(id);
  openRsvpForm(ev, rsvps.find((r) => r.uid === u.uid) || null);
}

// Host-only pass modal. The member list never carries passToken, so fetch it
// on demand through the ownership-checked firebase helper before rendering.
async function openMemberPass(uid) {
  const ev = state.currentEvent;
  if (!ev || !uid) return;
  let pass;
  try {
    pass = await fb.getMemberPass(ev.id, uid);
  } catch (e) {
    toast(e?.message || DB_MSG, "warnDot");
    return;
  }
  if (!pass || !pass.passToken) {
    toast("This member doesn't have a pass yet", "warnDot");
    return;
  }
  const member = (state.members || []).find((r) => r.uid === uid);
  closeRsvpForm();
  const url = passUrl(pass.passToken);
  const overlay = document.createElement("div");
  overlay.className = "l-modal-overlay";
  overlay.innerHTML = `
    <div class="l-modal l-pass-modal" role="dialog" aria-modal="true" aria-labelledby="l-pass-title">
      <div class="l-modal-head">
        <div>
          <div class="l-eyebrow">Member pass</div>
          <h2 class="l-modal-title" id="l-pass-title">${esc(pass.name || member?.name || "Member")}</h2>
          <p class="l-modal-sub">Show this QR at the gate.</p>
        </div>
        <button type="button" class="l-modal-close" data-close-modal aria-label="Close">${IX.close}</button>
      </div>
      <div class="l-modal-body l-pass-modal-body">
        <div class="l-qr-card">
          <div class="l-qr-frame">${qrSvg(url, { fg: "#12121C", margin: 2 })}</div>
          <p>Show this QR at the gate</p>
        </div>
      </div>
      <div class="l-actions l-modal-actions">
        <a class="l-primary l-block" href="${esc(url)}" target="_blank" rel="noopener">Open full pass</a>
      </div>
    </div>`;
  document.body.append(overlay);
  const onKey = (e) => { if (e.key === "Escape") closeRsvpForm(); };
  modalCleanup = () => { document.removeEventListener("keydown", onKey); overlay.remove(); };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest("[data-close-modal]")) closeRsvpForm();
  });
  document.addEventListener("keydown", onKey);
}

// ── organiser member directory ──────────────────────────────────────────────
function filteredMembers() {
  const q = String(state.memberQuery || "").trim().toLowerCase();
  if (!q) return state.members || [];
  const fields = enabledFormFields(state.currentEvent);
  return (state.members || []).filter((r) =>
    fields.some((f) => memberValue(r, f).toLowerCase().includes(q)) ||
    joinedLabel(r).toLowerCase().includes(q));
}
function memberRowsHTML(rows, fields) {
  if (!rows.length) {
    return `<tr><td class="l-table-empty" colspan="${fields.length + 3}">No members to show.</td></tr>`;
  }
  return rows.map((r) => {
    const status = r.status || "approved";
    const pending = status === "pending";
    const approved = status === "approved";
    return `<tr>
    ${fields.map((f) => `<td>${esc(memberValue(r, f)) || "—"}</td>`).join("")}
    <td class="l-member-status">${statusPill(r.status)}</td>
    <td class="l-member-joined">${esc(joinedLabel(r))}</td>
    <td class="l-member-actions">
      ${approved ? `<button type="button" class="l-mini-btn is-pass" data-action="member-pass" data-uid="${esc(r.uid)}"
        title="View member pass">${IX.pass}<span>Pass</span></button>` : ""}
      ${pending ? `<button type="button" class="l-mini-btn is-approve" data-action="member-approve" data-uid="${esc(r.uid)}"
        title="Approve member">${I.check}<span>Approve</span></button>
      <button type="button" class="l-mini-btn is-reject" data-action="member-reject" data-uid="${esc(r.uid)}"
        title="Reject member">${IX.close}<span>Reject</span></button>` : ""}
      <button type="button" class="l-mini-btn" data-action="member-edit" data-uid="${esc(r.uid)}"
        title="Edit member">${IX.edit}<span>Edit</span></button>
      <button type="button" class="l-mini-btn is-danger" data-action="member-delete" data-uid="${esc(r.uid)}"
        title="Remove member">${IX.close}<span>Remove</span></button>
    </td>
  </tr>`;
  }).join("");
}
function renderMembers() {
  const root = $("#l-members", mountNode);
  const ev = state.currentEvent;
  if (!root || !ev) return;
  const fields = enabledFormFields(ev);
  const rows = filteredMembers();
  root.innerHTML = `
    <div class="l-members-head">
      <div>
        <div class="l-eyebrow">Your guest list</div>
        <h2 class="l-members-title">Members (${state.members.length})</h2>
      </div>
      <div class="l-members-tools">
        <div class="l-search-wrap l-member-search-wrap">${IX.search}
          <input id="l-member-search" class="l-search l-member-search" type="search" autocomplete="off"
            placeholder="Search members…" value="${esc(state.memberQuery)}" aria-label="Search members">
        </div>
        <button type="button" class="l-outline" data-action="members-csv" title="Download members as CSV">${IX.arrow} Export CSV</button>
      </div>
    </div>
    <div class="l-member-table-wrap">
      <table class="l-member-table">
        <thead><tr>${fields.map((f) => `<th scope="col">${esc(f.label || f.key)}</th>`).join("")}
          <th scope="col">Status</th><th scope="col">Joined</th><th scope="col">Actions</th></tr></thead>
        <tbody id="l-member-rows">${memberRowsHTML(rows, fields)}</tbody>
      </table>
    </div>
    <p class="l-member-empty" id="l-member-empty" ${rows.length ? "hidden" : ""}>${
      state.memberQuery.trim()
        ? "No members match your search."
        : "No members yet — they'll appear here when people RSVP."
    }</p>`;
}
function refreshMembersTable() {
  const body = $("#l-member-rows", mountNode);
  if (!body) return;
  const rows = filteredMembers();
  body.innerHTML = memberRowsHTML(rows, enabledFormFields(state.currentEvent));
  const empty = $("#l-member-empty", mountNode);
  if (empty) {
    empty.hidden = rows.length > 0;
    empty.textContent = state.memberQuery.trim()
      ? "No members match your search."
      : "No members yet — they'll appear here when people RSVP.";
  }
}
function exportMembersCsv() {
  const ev = state.currentEvent;
  if (!ev) return;
  const fields = enabledFormFields(ev);
  const rows = filteredMembers();
  const head = [...fields.map((f) => f.label || f.key), "Status", "Joined"];
  const body = rows.map((r) => [...fields.map((f) => memberValue(r, f)), r.status || "approved", joinedLabel(r)]);
  const slug = String(ev.title || "members").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "members";
  download(`members-${slug}.csv`, toCsv([head, ...body]));
  toast(`Exported ${rows.length} ${rows.length === 1 ? "member" : "members"}`);
}
async function deleteMember(uid) {
  const ev = state.currentEvent;
  const member = (state.members || []).find((r) => r.uid === uid);
  if (!ev || !uid) return;
  if (!window.confirm(`Remove ${member?.name || member?.email || "this member"} from this event? This can't be undone.`)) return;
  try {
    if (DEMO) {
      state.rsvps[ev.id] = (state.rsvps[ev.id] || []).filter((r) => r.uid !== uid);
    } else {
      await fb.deleteRsvp(ev.id, uid);
      state.rsvps[ev.id] = await fb.listRsvps(ev.id);
    }
    toast("Member removed", "check");
    await refreshEventView(ev.id);
  } catch (e) { toast(e?.message || DB_MSG, "warnDot"); }
}
async function setMemberStatus(approve, uid) {
  const ev = state.currentEvent;
  if (!ev || !uid) return;
  try {
    if (DEMO) {
      const member = (state.rsvps[ev.id] || []).find((r) => r.uid === uid);
      if (member) member.status = approve ? "approved" : "rejected";
    } else if (approve) {
      await fb.approveMember(ev.id, uid);
      state.rsvps[ev.id] = await fb.listRsvps(ev.id);
    } else {
      await fb.rejectMember(ev.id, uid);
      state.rsvps[ev.id] = await fb.listRsvps(ev.id);
    }
    toast(approve ? "Member approved" : "Member rejected", "check");
    // Re-render the detail so the member list and the RSVP counts stay in sync.
    await refreshEventView(ev.id);
  } catch (e) { toast(e?.message || DB_MSG, "warnDot"); }
}

async function doShare() {
  const title = state.currentEvent?.title || document.title || "Event";
  const url = location.href;
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; }
    catch (e) { if (e?.name === "AbortError") return; }
  }
  await copyText(url);
  toast("Link copied");
}
function copyGateLink() {
  const code = state.currentEvent?.gate_code;
  if (!code) return;
  copyText(gateUrl(code));
  toast("Gate link copied");
}
async function doRsvp(id) { await openRsvpFor(id); }
async function doCancelRsvp(id) {
  try {
    if (DEMO) {
      state.rsvps[id] = (state.rsvps[id] || []).filter((r) => r.uid !== state.user?.uid);
    } else {
      await fb.cancelRsvp(id, state.user);
      delete state.rsvps[id];
    }
    toast("RSVP cancelled", "check");
    await refreshEventView(id);
  } catch (e) { toast(e?.message || DB_MSG, "warnDot"); }
}
async function doDelete(id) {
  if (DEMO) { toast("Demo mode — nothing was deleted"); return; }
  if (!window.confirm("Delete this event? This can't be undone.")) return;
  try {
    await fb.deleteV2Event(id);
    invalidate();
    toast("Event deleted", "check");
    location.hash = "#/";
  } catch (e) { toast(e?.message || DB_MSG, "warnDot"); }
}

// ── routing / events ────────────────────────────────────────────────────────
async function route() {
  const seq = ++renderSeq;
  closeRsvpForm();
  state.currentEvent = null;
  state.myPass = null;
  state.memberQuery = "";
  // RSVP counts can change in another browser while this page is open; never
  // reuse a cached count across in-app (hash) navigation.
  state.rsvps = {};
  const h = location.hash.replace(/^#\/?/, "");
  const r = currentRoute();
  const wide = r === "create" || r === "event" ? " l-main-wide" : "";
  mountNode.className = "luma-root";
  mountNode.innerHTML = `${navHTML()}<main class="l-main${wide}" id="l-view" aria-live="polite">${skeleton()}</main>`;
  if (r === "calendar") return renderCalendar(seq);
  if (r === "discover") return renderDiscover(seq);
  if (r === "create") return renderCreate(h.startsWith("create/") ? h.slice(7) : null, seq);
  if (r === "event") return renderEvent(h.slice(6), seq);
  return renderFeed(seq);
}

function onClick(e) {
  const el = e.target.closest("[data-action]");
  if (!el || !mountNode.contains(el)) return;
  const a = el.dataset.action;
  if (a === "signin") { signedIn(); return; }
  if (a === "signout") { fb.signOutUser(); toast("Signed out", "check"); return; }
  if (a === "account") { toggleAccountMenu(); return; }
  if (a === "create") { createGate(); return; }
  if (a === "clock") { toast(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })); return; }
  if (a === "notify") { toast("You're all caught up"); return; }
  if (a === "cal-prev") {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
    state.calDay = null; route(); return;
  }
  if (a === "cal-next") {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
    state.calDay = null; route(); return;
  }
  if (a === "cal-today") {
    state.calMonth = new Date(); state.calDay = new Date().getDate(); route(); return;
  }
  if (a === "cal-day") {
    if (el.dataset.out === "1") return;
    const n = Number(el.dataset.day);
    state.calDay = state.calDay === n ? null : n;
    route(); return;
  }
  if (a === "chip") { state.discoverKey = el.dataset.key; refreshDiscover(); return; }
  if (a === "art") {
    document.querySelectorAll(".l-art-thumb", mountNode).forEach((t) => t.classList.toggle("is-active", t === el));
    const key = el.dataset.key;
    $("#l-cover-input", mountNode).value = key;
    const preview = $("#l-cover-preview", mountNode);
    if (preview) preview.style.backgroundImage = `url('${coverUrl(key)}')`;
    return;
  }
  if (a === "field-add") { addFormField(); return; }
  if (a === "field-remove") { removeFormField(Number(el.dataset.index)); return; }
  if (a === "share") { doShare(); return; }
  if (a === "copy-gate") { copyGateLink(); return; }
  if (a === "rsvp" || a === "edit-rsvp") { doRsvp(el.dataset.id); return; }
  if (a === "cancel-rsvp") { doCancelRsvp(el.dataset.id); return; }
  if (a === "member-approve") { setMemberStatus(true, el.dataset.uid); return; }
  if (a === "member-reject") { setMemberStatus(false, el.dataset.uid); return; }
  if (a === "member-pass") { openMemberPass(el.dataset.uid); return; }
  if (a === "members-csv") { exportMembersCsv(); return; }
  if (a === "member-edit") {
    const member = (state.members || []).find((r) => r.uid === el.dataset.uid);
    if (member && state.currentEvent) openRsvpForm(state.currentEvent, member, true);
    return;
  }
  if (a === "member-delete") { deleteMember(el.dataset.uid); return; }
  if (a === "edit") { go(`#/create/${el.dataset.id}`); return; }
  if (a === "delete") { doDelete(el.dataset.id); return; }
}
function onInput(e) {
  if (e.target.id === "l-search") {
    state.discoverQ = e.target.value;
    refreshDiscover();
  } else if (e.target.id === "l-member-search") {
    state.memberQuery = e.target.value;
    refreshMembersTable();
  }
}
function tickClock() {
  const el = $("#l-clock", mountNode);
  if (el) el.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  mountNode = $("#luma-root") || document.body;
  if (!coreConfigured || !fb.configured) {
    mountNode.innerHTML = `<div class="l-notconfigured">
      <div class="l-empty-icon">${IX.spark}</div>
      <h1>Events aren't connected yet</h1>
      <p>Add your Firebase web config to <code>firebase-config.js</code>, then reload to load events.</p>
    </div>`;
    return;
  }
  try { const r = await fb.redirectResult(); if (r?.user) state.user = r.user; } catch {}
  fb.onAuth((u) => {
    const changed = (u?.uid || null) !== (state.user?.uid || null);
    state.user = u;
    if (changed && mountNode) route();
  });
  window.addEventListener("hashchange", route);
  mountNode.addEventListener("click", onClick);
  mountNode.addEventListener("input", onInput);
  mountNode.addEventListener("submit", onSubmit);
  setInterval(tickClock, 30000);
  route();
}

boot();

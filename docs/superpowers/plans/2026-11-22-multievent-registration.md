# Phase A: Multi-event fest + public registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fest → sub-events, Google-signed-in public registration, instant per-sub-event passes, a unified registrations table, and live Google Sheets append from the organiser's browser.

**Architecture:** New collections (`gp_fests`, `gp_fests/{festId}/events`, `gp_reg_public`, `gp_fests/{festId}/registrations`, per-event pass subcollection) join the existing gate/claim model. A new `register/` page handles student sign-in and registration. `assets/js/sheets.js` holds the Google Identity Services token client and Sheets append. The organiser dashboard owns Sheet sync via an `onSnapshot` on registrations.

**Tech Stack:** Firebase Auth + Firestore + Rules (existing), Google Identity Services + Sheets REST API, plain ES modules, no build step.

---

## File structure

**Create:** `register/index.html`, `assets/js/register.js`, `assets/js/sheets.js`
**Modify:** `config.js`→`firebase-config.js` (add `googleOAuthClientId`), `firestore.rules`, `vercel.json`, `firebase.json`, `assets/js/firebase.js`, `assets/js/organiser.js`, `assets/js/core.js`, `assets/css/gatepass.css`, `README.md`, `SETUP.md`
**Test:** `tests/firestore.test.js`, new `tests/e2e/registration.spec.js`

---

## Task 1 — Config, Sheets service, CSP

**Files:** `firebase-config.js`, new `assets/js/sheets.js`, `vercel.json`, `firebase.json`, three HTML pages

- [ ] **Step 1:** Add to `firebase-config.js` inside `window.FIREBASE`, after `appId`:
```js
  // OAuth client ID (Web application) for the organiser's Google Sheet access.
  // Google Cloud → APIs & Services → Credentials; authorised origin = your deployed domain.
  googleOAuthClientId: "",
```

- [ ] **Step 2:** Create `assets/js/sheets.js`:
```js
// Direct Google Sheets writes from the organiser's browser. No server, no Apps Script.
let tokenClient = null, accessToken = null, tokenExpiry = 0;

function gis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google.accounts.oauth2);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => window.google?.accounts?.oauth2 ? resolve(window.google.accounts.oauth2) : reject(new Error("Google Identity Services failed to load"));
    s.onerror = () => reject(new Error("Could not load Google Identity Services"));
    document.head.append(s);
  });
}

export async function connectSheet(clientId) {
  if (!clientId) throw new Error("Add your Google OAuth client ID to firebase-config.js first.");
  const g = await gis();
  tokenClient = g.initTokenClient({
    client_id: clientId,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    callback: (r) => {
      if (r.error) throw new Error(r.error);
      accessToken = r.access_token;
      tokenExpiry = Date.now() + (r.expires_in || 3600) * 1000;
    },
  });
  return new Promise((resolve, reject) => {
    tokenClient.callback = (r) => {
      if (r.error) return reject(new Error(r.error));
      accessToken = r.access_token;
      tokenExpiry = Date.now() + (r.expires_in || 3600) * 1000;
      resolve(true);
    };
    tokenClient.requestAccessToken({ prompt: "consent" });
  });
}

export const hasSheetToken = () => !!accessToken;

async function token() {
  if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
  if (!tokenClient) throw new Error("Connect the Google Sheet first.");
  await new Promise((resolve, reject) => {
    tokenClient.callback = (r) => {
      if (r.error) return reject(new Error(r.error));
      accessToken = r.access_token;
      tokenExpiry = Date.now() + (r.expires_in || 3600) * 1000;
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: "none" });
  });
  return accessToken;
}

export function sheetIdFromUrl(input = "") {
  const m = String(input).match(/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : String(input).trim() || "";
}

export async function appendRows(sheetId, range, rows) {
  const t = await token();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range || "Registrations")}:append?valueInputOption=USER_ENTERED`,
    { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: rows }) }
  );
  if (!res.ok) {
    let msg = `Google Sheets returned ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}
```

- [ ] **Step 3:** CSP updates in both `vercel.json` and `firebase.json`: add `https://accounts.google.com` to `script-src`, `https://sheets.googleapis.com` to `connect-src`. Keep all other directives unchanged.
- [ ] **Step 4:** Verify: `node --check assets/js/sheets.js`, JSON parses, commit `feat: add Google Sheets token service and CSP`.

---

## Task 2 — Firestore rules for fest collections

**Files:** `firestore.rules`

- [ ] **Step 1:** Append these match blocks before the closing braces (keep all existing rules intact):

```
    // ── Phase A: fests, sub-events, public registration ──
    function isFestOwner(festId) {
      return signedIn() && get(/databases/$(database)/documents/gp_fests/$(festId)).data.ownerId == request.auth.uid;
    }
    function isSubEventOwner(festId, eventId) {
      return isFestOwner(festId)
        && exists(/databases/$(database)/documents/gp_fests/$(festId)/events/$(eventId));
    }

    match /gp_fests/{festId} {
      allow get, update, delete: if isFestOwner(festId);
      allow list: if false;
      allow create: if signedIn() && request.resource.data.ownerId == request.auth.uid;
    }
    match /gp_users/{uid}/fests/{festId} {
      allow read, create, update, delete: if signedIn() && uid == request.auth.uid;
    }
    match /gp_fests/{festId}/events/{eventId} {
      allow read, create, update, delete: if isFestOwner(festId);
    }
    match /gp_reg_public/{eventId} {
      allow get: if signedIn();
      allow list: if false;
      allow create, update, delete: if isFestOwner(request.resource.data.festId);
    }

    // A student may create exactly one pass of their own for an open event.
    match /gp_fests/{festId}/events/{eventId}/passes/{passId} {
      allow read: if isFestOwner(festId);
      allow create: if signedIn()
        && request.resource.data.uid == request.auth.uid
        && get(/databases/$(database)/documents/gp_reg_public/$(eventId)).data.registrationOpen == true
        && request.resource.data.keys().hasOnly(['name','contact','token','uid','registrationId','createdAt','checkedInAt','gate']);
      allow update, delete: if isFestOwner(festId);
    }
    match /gp_fests/{festId}/registrations/{regId} {
      allow read, update, delete: if isFestOwner(festId);
      allow create: if signedIn()
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.keys().hasOnly(['eventId','eventName','festId','name','email','phone','uid','passId','token','createdAt','sheetSynced']);
    }
    match /gp_passes/{token} {
      allow create: if signedIn()
        && request.resource.data.keys().hasOnly(['id','festId','eventId','event','name','checkedInAt','gate']);
    }
```

Note the existing `match /gp_passes/{token}` block already grants `get`, lists/owner updates; Firestore ORs the two `create` grants, so this adds the student path without removing attendee reads.
`gp_gates/{code}/roster/{passId}` already allows owner `create`; add a second `create` grant for signed-in students whose `code` matches a descriptor:
```
      allow create: if isOwner(get(/databases/$(database)/documents/gp_gates/$(code)).data.eventId)
        || (signedIn() && get(/databases/$(database)/documents/gp_reg_public/$(get(/databases/$(database)/documents/gp_gates/$(code)).data.eventId)).data.gateCode == code);
```
Replace the existing `allow create, delete:` line accordingly; keep `delete` owner-only and `read` by code.

- [ ] **Step 2:** Verify rules compile in emulator, commit `feat(firebase): rules for fests and self-registration`.

---

## Task 3 — Data layer: fests, sub-events, registration

**Files:** `assets/js/firebase.js`

- [ ] **Step 1:** Add exports (all use existing imports; `getDocs`, `writeBatch`, `newCode`, `newToken`, `stamp` already present):
```js
export async function listFests(uid) {
  const snap = await getDocs(collection(db, "gp_users", uid, "fests"));
  return snap.docs.map((d) => ({ id: d.id, name: d.data().name, starts_at: stamp(d.data().startsAt) }));
}
export async function getFest(id) {
  const s = await getDoc(doc(db, "gp_fests", id));
  if (!s.exists()) return null;
  const d = s.data();
  return { id, name: d.name, club: d.club || "", venue: d.venue || "", art: d.art || 0,
    starts_at: stamp(d.startsAt), sheetId: d.sheetId || "", sheetRange: d.sheetRange || "Registrations" };
}
export async function createFest(row) {
  const id = doc(collection(db, "gp_fests")).id;
  const batch = writeBatch(db);
  batch.set(doc(db, "gp_fests", id), { ownerId: auth.currentUser.uid, name: row.name,
    club: row.club, venue: row.venue, art: row.art, startsAt: new Date(row.starts_at),
    sheetId: "", sheetRange: "Registrations", createdAt: serverTimestamp() });
  batch.set(doc(db, "gp_users", auth.currentUser.uid, "fests", id), { name: row.name, startsAt: new Date(row.starts_at) });
  await batch.commit();
  return id;
}
export async function setFestSheet(festId, sheetId, sheetRange) {
  await updateDoc(doc(db, "gp_fests", festId), { sheetId, sheetRange });
}
export async function listSubEvents(festId) {
  const snap = await getDocs(collection(db, "gp_fests", festId, "events"));
  return snap.docs.map((d) => { const e = d.data(); return { id: d.id, festId, name: e.name,
    club: e.club || "", venue: e.venue || "", art: e.art || 0, starts_at: stamp(e.startsAt),
    gate_code: e.gateCode, registration_open: !!e.registrationOpen,
    capacity: e.capacity || 0, total: e.total || 0, checked: e.checked || 0 }; });
}
export async function createSubEvent(festId, row) {
  const id = doc(collection(db, "gp_fests", festId, "events")).id;
  const code = newCode();
  const batch = writeBatch(db);
  batch.set(doc(db, "gp_fests", festId, "events", id), { festId, name: row.name, club: row.club,
    venue: row.venue, art: row.art, startsAt: new Date(row.starts_at), gateCode: code,
    registrationOpen: row.registration_open !== false, capacity: row.capacity || 0,
    total: 0, checked: 0, bounced: 0, recent: [], createdAt: serverTimestamp() });
  batch.set(doc(db, "gp_gates", code), { festId, eventId: id, name: row.name, club: row.club,
    venue: row.venue, art: row.art, startsAt: new Date(row.starts_at),
    total: 0, checked: 0, bounced: 0, recent: [] });
  batch.set(doc(db, "gp_reg_public", id), { festId, name: row.name, club: row.club, venue: row.venue,
    art: row.art, startsAt: new Date(row.starts_at), gateCode: code,
    registrationOpen: row.registration_open !== false, capacity: row.capacity || 0, total: 0 });
  await batch.commit();
  return { id, code };
}
export async function setRegistrationOpen(festId, eventId, open) {
  await updateDoc(doc(db, "gp_fests", festId, "events", eventId), { registrationOpen: open });
  await updateDoc(doc(db, "gp_reg_public", eventId), { registrationOpen: open });
}
export async function getRegistrationDescriptor(eventId) {
  const s = await getDoc(doc(db, "gp_reg_public", eventId));
  if (!s.exists()) return null;
  const d = s.data();
  return { event_id: eventId, fest_id: d.festId, name: d.name, club: d.club || "",
    venue: d.venue || "", art: d.art || 0, starts_at: stamp(d.startsAt),
    registration_open: !!d.registrationOpen, capacity: d.capacity || 0, total: d.total || 0 };
}
export async function registerStudent(desc, user, fields) {
  const passId = doc(collection(db, "gp_fests", desc.fest_id, "events", desc.event_id, "passes")).id;
  const token = newToken();
  const gateRef = await getDoc(doc(db, "gp_gates", await gateCodeFor(desc.event_id))).catch(() => null);
  // gateCodeFor is owner-only; instead the descriptor read above intentionally omits it for students.
  // The roster write is done by the registration page using the code passed in explicitly.
  throw new Error("use registerStudentWithCode");
}
```
The final placeholder above is intentionally replaced by the real function below — do not ship it:
```js
export async function registerStudentWithCode(desc, user, fields, code) {
  const eventPath = ["gp_fests", desc.fest_id, "events", desc.event_id];
  const passId = doc(collection(db, ...eventPath, "passes")).id;
  const token = newToken();
  const regRef = doc(collection(db, "gp_fests", desc.fest_id, "registrations"));
  const batch = writeBatch(db);
  batch.set(doc(db, ...eventPath, "passes", passId), { name: fields.name, contact: fields.contact,
    token, uid: user.uid, registrationId: regRef.id, createdAt: serverTimestamp(), checkedInAt: null, gate: "" });
  batch.set(regRef, { eventId: desc.event_id, eventName: desc.name, festId: desc.fest_id,
    name: fields.name, email: fields.email || "", phone: fields.phone || "", uid: user.uid,
    passId, token, createdAt: serverTimestamp(), sheetSynced: false });
  batch.set(doc(db, "gp_passes", token), { id: passId, festId: desc.fest_id, eventId: desc.event_id,
    event: { name: desc.name, club: desc.club, starts_at: desc.starts_at, venue: desc.venue, art: desc.art },
    name: fields.name, checkedInAt: null, gate: "" });
  batch.set(doc(db, "gp_gates", code, "roster", passId), { name: fields.name,
    nameLower: fields.name.toLowerCase(), hint: fields.contact ? "set" : "", token,
    checkedInAt: null, gate: "" });
  await batch.commit();
  return { token, passId, registrationId: regRef.id };
}
export async function listRegistrations(festId) {
  const snap = await getDocs(collection(db, "gp_fests", festId, "registrations"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data(), created_at: stamp(d.data().createdAt),
    sheet_synced: !!d.data().sheetSynced }));
}
export async function markSheetSynced(festId, regId) {
  await updateDoc(doc(db, "gp_fests", festId, "registrations", regId), { sheetSynced: true });
}
export function watchRegistrations(festId, cb) {
  return onSnapshot(collection(db, "gp_fests", festId, "registrations"), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data(), created_at: stamp(d.data().createdAt),
      sheet_synced: !!d.data().sheetSynced })));
  });
}
```

- [ ] **Step 2:** Verify `node --check`, commit `feat(firebase): fest and registration data layer`.

---

## Task 4 — Organiser fest dashboard + Sheet sync

**Files:** `assets/js/organiser.js`, `index.html`, `assets/css/gatepass.css`

- [ ] **Step 1:** Add a fest route to `route()`: `#/fests` → `festListView()`, `#/fest/{id}` → `festView(id)`. Keep legacy `#/e/...` intact.
- [ ] **Step 2:** `festListView()` mirrors `listView()` markup with `fb.listFests(session.uid)`; "New fest" button opens a small form (name, club, venue, date) calling `fb.createFest`.
- [ ] **Step 3:** `festView(id)` shows fest details, a "Connect Google Sheet" block (Sheet URL + range inputs; Save calls `fb.setFestSheet`; Connect calls `sheets.connectSheet(cfg.googleOAuthClientId)`), a "Sub-events" list with an "Add sub-event" form (`fb.createSubEvent`), each row with its gate code, registration link (`#/register/{eventId}`), and an Open/Close registration toggle (`fb.setRegistrationOpen`).
- [ ] **Step 4:** "All registrations" table from `fb.watchRegistrations(festId)`: columns timestamp, sub-event, name, email, phone, pass link, Sheet status. Add CSV export using existing `toCsv`.
- [ ] **Step 5:** Sheet sync loop: in `festView`, when `sheetId` and token exist, call `fb.watchRegistrations` and for each row with `!sheet_synced`, call `sheets.appendRows(sheetId, range, [[created_at, festName, eventName, name, email, phone, passUrl]])` then `fb.markSheetSynced(festId, row.id)`. Guard with a `syncing` boolean; show a warning if append fails. Call `sheets.connectSheet` again on token expiry (handled in `sheets.js`).
- [ ] **Step 6:** Import `cfg` from core.js and `* as sheets from "./sheets.js"`. Verify `node --check`, commit `feat: fest dashboard with live Sheets sync`.

---

## Task 5 — Public registration page

**Files:** `register/index.html`, `assets/js/register.js`, `assets/css/gatepass.css`

- [ ] **Step 1:** `register/index.html` — same import map as other pages, `../firebase-config.js`, `../assets/js/register.js`; a `<main>` with `#view` skeleton, mast and scallops; title "Register · GatePass".
- [ ] **Step 2:** `register.js`:
  - read `eventId` from hash `#/register/{id}` or query
  - `fb.getRegistrationDescriptor(id)`; if null → "link no longer valid"
  - use `fb.onAuth(cb)`; if no user → Google sign-in button calling `fb.signIn()`
  - form: name (required), email, phone; show closed/full messages
  - on submit: call `fb.registerStudentWithCode(desc, user, fields, descriptor.gateCode)` — **note:** the descriptor returned to students must include `gateCode` for this; add it to `getRegistrationDescriptor()` return as `gate_code: d.gateCode` (it is already in the signed-in-readable doc).
  - after success: redirect to `passUrl(token)` with a toast "You're registered — show this at the gate"
  - errors mapped to friendly text; never expose raw Firestore codes.
- [ ] **Step 3:** Style the form with existing `.field`, `.input`, `.btn-primary` classes; no new visual language.
- [ ] **Step 4:** Verify `node --check`, commit `feat: public Google-signed-in registration page`.

---

## Task 6 — Tests, docs, deploy

**Files:** `tests/firestore.test.js`, `tests/e2e/registration.spec.js`, `README.md`, `SETUP.md`

- [ ] **Step 1:** Extend rules tests: descriptor `get` allowed for signed-in / denied for anonymous / `list` denied; student can create own pass+registration but not with someone else's `uid`; registrations readable only by fest owner; closed-event registration denied; public pass doc never contains `gateCode`; roster create by student with matching descriptor code allowed, wrong code denied.
- [ ] **Step 2:** E2E registration test (stub Sheets API via `page.route('**/sheets.googleapis.com/**')`): sign in a student (use emulator + stubbed Auth as the existing E2E does), submit form, assert pass page renders, organiser table shows the row, stubbed Sheets append received once with the right values.
- [ ] **Step 3:** README: describe fest/sub-events, public registration link, and the direct Sheets connection (including OAuth setup steps and the live-while-dashboard-open caveat). SETUP.md: OAuth client ID creation, consent screen, authorised origins, Sheet URL/range.
- [ ] **Step 4:** Run `npm run test:rules` (emulator), `npm run test:e2e`, then `vercel --prod --yes`. Commit `test+docs: Phase A registration and Sheet sync`.

---

## Self-review

- Spec coverage: fest model → T2/T3; sub-events/gate codes → T2/T3; student Google sign-in + registration → T5; instant pass → T3/T5; live Sheets → T1/T4; unified table → T3/T4; tradeoffs documented → T6.
- Type consistency: all functions return snake_case UI fields (`starts_at`, `gate_code`, `registration_open`, `sheet_synced`) and camelCase Firestore fields; statuses unchanged.
- No placeholders: Task 3's temporary `registerStudent` stub is explicitly replaced in the same task by `registerStudentWithCode` — the implementer must ship only the latter.

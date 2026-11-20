# GatePass Firebase Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port GatePass from Supabase to Firebase Auth + Firestore with zero visual change, preserving the one-accepted-scan-per-pass guarantee.

**Architecture:** A new `assets/js/firebase.js` data layer replaces Supabase RPCs. Organiser-owned data lives in path-scoped subcollections so Security Rules can authorize by path; public reads use the pass token as a doc ID and the gate code as a subcollection path segment (capability-based access). The one-shot scan is a Firestore transaction that creates a claim doc keyed by pass ID; rules independently enforce the same invariant.

**Tech Stack:** Firebase modular ESM v11.10.0 via CDN import map, Firestore, Firebase Auth (Google), plain HTML/CSS/ES modules (no build step), Playwright + `@firebase/rules-unit-testing` for dev tests.

---

## File structure

**Create**
- `firebase-config.js` — web config on `window.FIREBASE`
- `assets/js/firebase.js` — all Auth/Firestore operations, same return shapes as old RPCs
- `firestore.rules` — complete ruleset
- `firestore.indexes.json` — composite indexes
- `SETUP.md` — Firebase console steps
- `tests/firestore.test.js` — rules unit tests
- `tests/e2e/duplicate-scan.spec.js` — Playwright two-gate test

**Modify**
- `index.html`, `gate/index.html`, `p/index.html` — import map + script tags
- `assets/js/core.js` — remove Supabase bootstrap/RPC, keep UI helpers, add `DB_MSG`
- `assets/js/organiser.js`, `gate.js`, `pass.js` — swap data-layer calls only
- `README.md` — Firebase setup

**Delete**
- `config.js`, `schema.sql`, `vendor/supabase.js`

---

## Task 1 — Firebase config, import maps, core.js

**Files:** Create `firebase-config.js`; Modify `index.html`, `gate/index.html`, `p/index.html`, `assets/js/core.js`

- [ ] **Step 1: Create `firebase-config.js`**

```js
// GatePass Firebase configuration. This is the only file you edit to use your own project.
// These values are public by design; Firestore Security Rules protect the data.
// Never put a service-account key or any secret here.
window.FIREBASE = {
  apiKey: "AIzaSyDDhLEv48jfWKGWWfLW3wDjlZ6zAgD4hek",
  authDomain: "fest-website-8dcd7.firebaseapp.com",
  projectId: "fest-website-8dcd7",
  storageBucket: "fest-website-8dcd7.firebasestorage.app",
  messagingSenderId: "554053980634",
  appId: "1:554053980634:web:081d4676b86b394a06b0e3",
};
```

- [ ] **Step 2: Add import map to `index.html` head** — replace lines 15–17:

```html
<script type="importmap">
{"imports":{
  "firebase/app":"https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js",
  "firebase/auth":"https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js",
  "firebase/firestore":"https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js"
}}
</script>
<script defer src="firebase-config.js"></script>
<script type="module" src="assets/js/organiser.js"></script>
```

- [ ] **Step 3: `gate/index.html`** — replace lines 13–14 with the same import map (indentation of paths unchanged) plus:

```html
<script defer src="../firebase-config.js"></script>
<script type="module" src="../assets/js/gate.js"></script>
```

- [ ] **Step 4: `p/index.html`** — replace lines 13–14 with the same import map plus:

```html
<script defer src="../firebase-config.js"></script>
<script type="module" src="../assets/js/pass.js"></script>
```

- [ ] **Step 5: Strip Supabase from `assets/js/core.js`** — delete lines 2–6 (`qrcode` import stays; remove `cfg`, `configured`, `RpcError`, `rpc()`) and line 190 (`PAUSED_MSG`). Keep `ROOT`, `ART`, `artUrl`, `passUrl`, `gateUrl`, `fmtCode`, all formatters, `esc`, `store`, `copyText`, `toast`, `download`, `qrSvg`, `I`, `setArt`, `paintIcons`. Add after `ROOT`:

```js
export const DB_MSG = "The database is temporarily unavailable. Try again in a moment.";
```

- [ ] **Step 6: Verify** — run `python -m http.server 8123` in repo root, open `/`, `/gate/`, `/p/#bad`. Expected: pages render, no console errors *except* a module resolution error for `./firebase.js` until Task 3 creates it.

- [ ] **Step 7: Commit** — `git add firebase-config.js index.html gate/index.html p/index.html assets/js/core.js && git commit -m "feat(firebase): config, import maps, strip Supabase from core"`

---

## Task 2 — Firestore rules, indexes, setup doc

**Files:** Create `firestore.rules`, `firestore.indexes.json`, `SETUP.md`

- [ ] **Step 1: Write `firestore.rules`**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() {
      return request.auth != null;
    }

    function eventData(eventId) {
      return get(/databases/$(database)/documents/gp_events/$(eventId)).data;
    }

    function isOwner(eventId) {
      return signedIn() && eventData(eventId).ownerId == request.auth.uid;
    }

    function passMatches(token, passId, eventId) {
      return token is string
        && get(/databases/$(database)/documents/gp_passes/$(token)).data.id == passId
        && get(/databases/$(database)/documents/gp_passes/$(token)).data.eventId == eventId;
    }

    // Organiser's event list index — scoped by uid so no query rules are needed.
    match /gp_users/{uid}/events/{eventId} {
      allow read, create, update, delete: if signedIn() && uid == request.auth.uid;
    }

    match /gp_events/{eventId} {
      allow get: if isOwner(eventId);
      allow list: if false;
      allow create: if signedIn() && request.resource.data.ownerId == request.auth.uid;
      allow update, delete: if isOwner(eventId);
    }

    match /gp_events/{eventId}/passes/{passId} {
      allow read, create, update, delete: if isOwner(eventId);
    }

    // The code in the path is the capability; no client can enumerate codes.
    match /gp_gates/{code} {
      allow get: if true;
      allow list: if false;
      allow create: if isOwner(request.resource.data.eventId);
      allow delete: if isOwner(resource.data.eventId);
      allow update: if isOwner(resource.data.eventId)
        || (resource.data.eventId == request.resource.data.eventId
            && request.resource.data.diff(resource.data).affectedKeys()
                 .hasOnly(['total', 'checked', 'bounced', 'recent']));
    }

    match /gp_gates/{code}/roster/{passId} {
      allow read: if exists(/databases/$(database)/documents/gp_gates/$(code));
      allow create, delete: if isOwner(
        get(/databases/$(database)/documents/gp_gates/$(code)).data.eventId);
      allow update: if isOwner(get(/databases/$(database)/documents/gp_gates/$(code)).data.eventId)
        || (exists(/databases/$(database)/documents/gp_gates/$(code))
            && request.resource.data.diff(resource.data).affectedKeys()
                 .hasOnly(['checkedInAt', 'gate']));
    }

    // Attendee pass: the 32-char token is the doc ID and the capability.
    match /gp_passes/{token} {
      allow get: if true;
      allow list: if false;
      allow create: if isOwner(request.resource.data.eventId);
      // Gate staff hold only the token (from the QR). They may flip the display
      // stamp; the authoritative claim doc is still the one-shot gate.
      allow update: if isOwner(resource.data.eventId)
        || request.resource.data.diff(resource.data).affectedKeys().hasOnly(['checkedInAt', 'gate']);
      allow delete: if isOwner(resource.data.eventId);
    }

    // The one-shot claim lives under the gate code: the code is the read capability,
    // so no gate code is ever stored in a document an attendee could read.
    match /gp_gates/{code}/claims/{passId} {
      allow read: if exists(/databases/$(database)/documents/gp_gates/$(code));
      allow create: if !exists(/databases/$(database)/documents/gp_gates/$(code)/claims/$(passId))
        && get(/databases/$(database)/documents/gp_gates/$(code)).data.eventId == request.resource.data.eventId
        && passMatches(request.resource.data.token, passId, request.resource.data.eventId)
        && request.resource.data.scannedAt == request.time;
      allow update: if false;
      allow delete: if isOwner(get(/databases/$(database)/documents/gp_gates/$(code)).data.eventId);
    }

    match /gp_gates/{code}/claims/{passId}/repeats/{rid} {
      allow read: if exists(/databases/$(database)/documents/gp_gates/$(code));
      allow create: if get(/databases/$(database)/documents/gp_gates/$(code)).data.eventId == request.resource.data.eventId
        && request.resource.data.scannedAt == request.time;
      allow update: if false;
      allow delete: if isOwner(get(/databases/$(database)/documents/gp_gates/$(code)).data.eventId);
    }
  }
}
```

Note: `gp_gates/{code}` carries `checked`, `bounced` and a `recent` array (last 6 scans) so gate staff can update/read counts and recent activity without an owner-only write or an extra collection.

- [ ] **Step 2: Write `firestore.indexes.json`**

```json
{
  "indexes": [
    {
      "collectionGroup": "roster",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "nameLower", "order": "ASCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

- [ ] **Step 3: Write `SETUP.md`**

```md
# Firebase setup for GatePass

1. Open the Firebase console for your project. Enable **Firestore Database** (production mode) and choose a region.
2. Enable **Authentication → Sign-in method → Google**, set a support email, and add your deployed domain under **Authorised domains**.
3. Publish `firestore.rules` (Firebase CLI `firebase deploy --only firestore:rules`, or paste into the Rules tab) and `firestore.indexes.json` (`firebase deploy --only firestore:indexes`).
4. Copy the web app config into `firebase-config.js`.
5. Deploy to GitHub Pages or Firebase Hosting. No build step is needed.
6. Sign in with Google, create an event, upload a small CSV, and test with two phones before the real event.

## Data layout
All collections are prefixed `gp_` so the project can be shared. The gate code and pass token are capabilities: staff and attendees need no account. The one accepted scan per pass is enforced by the claim document ID and by Security Rules.
```

- [ ] **Step 4: Commit** — `git add firestore.rules firestore.indexes.json SETUP.md && git commit -m "feat(firebase): Firestore rules, indexes and setup guide"`

---

## Task 3 — Data layer: init, auth, events

**Files:** Create `assets/js/firebase.js`

- [ ] **Step 1: Create the module with imports, init and helpers**

```js
import { initializeApp } from "firebase/app";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, limit, writeBatch, runTransaction,
  serverTimestamp, increment, onSnapshot,
} from "firebase/firestore";

const cfg = window.FIREBASE || {};
export const configured = !!(cfg.apiKey && cfg.projectId && cfg.appId);

export const app = configured ? initializeApp(cfg) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;

const COL = "gp_events", PASS_PUB = "gp_passes", GATES = "gp_gates";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) {
    if (b < 248 && out.length < 8) out += ALPHABET[b % 31];
    if (out.length === 8) break;
  }
  return out.length === 8 ? out : newCode();
}
export function newToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const stamp = (v) => v?.toDate?.()?.toISOString?.() || v || null;
export const onAuth = (cb) => onAuthStateChanged(auth, (u) => cb(u || null));

export async function signIn() {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/popup-closed-by-user") {
      await signInWithRedirect(auth, new GoogleAuthProvider());
      return;
    }
    throw e;
  }
}
export const signOutUser = () => signOut(auth);
export const redirectResult = () => getRedirectResult(auth);
```

- [ ] **Step 2: Event CRUD**

```js
export async function listEvents(uid) {
  const snap = await getDocs(collection(db, "gp_users", uid, "events"));
  return snap.docs.map((d) => ({ id: d.id, name: d.data().name, starts_at: stamp(d.data().startsAt) }));
}

export async function getEvent(id) {
  const s = await getDoc(doc(db, COL, id));
  if (!s.exists()) return null;
  const d = s.data();
  return {
    id, name: d.name, club: d.club || "", venue: d.venue || "", art: d.art || 0,
    starts_at: stamp(d.startsAt), gate_code: d.gateCode,
  };
}

export async function createEvent(row) {
  const id = doc(collection(db, COL)).id;
  const code = newCode();
  const batch = writeBatch(db);
  batch.set(doc(db, COL, id), {
    ownerId: auth.currentUser.uid,
    name: row.name, club: row.club, venue: row.venue, art: row.art,
    startsAt: new Date(row.starts_at), gateCode: code, total: 0, createdAt: serverTimestamp(),
  });
  batch.set(doc(db, "gp_users", auth.currentUser.uid, "events", id), {
    name: row.name, startsAt: new Date(row.starts_at),
  });
  batch.set(doc(db, GATES, code), {
    eventId: id,
    name: row.name, club: row.club, venue: row.venue, art: row.art,
    startsAt: new Date(row.starts_at),
    total: 0, checked: 0, bounced: 0, recent: [],
  });
  await batch.commit();
  return id;
}

export async function updateEvent(id, row) {
  await updateDoc(doc(db, COL, id), {
    name: row.name, club: row.club, venue: row.venue, art: row.art,
    startsAt: new Date(row.starts_at),
  });
  const ue = doc(db, "gp_users", auth.currentUser.uid, "events", id);
  if ((await getDoc(ue)).exists()) {
    await updateDoc(ue, { name: row.name, startsAt: new Date(row.starts_at) });
  }
  const ev = await getDoc(doc(db, COL, id));
  const gate = await getDoc(doc(db, GATES, ev.data().gateCode));
  if (gate.exists()) {
    await updateDoc(gate.ref, {
      name: row.name, club: row.club, venue: row.venue, art: row.art,
      startsAt: new Date(row.starts_at),
    });
  }
}

export async function deleteEvent(id) {
  const ev = await getDoc(doc(db, COL, id));
  if (!ev.exists()) return;
  const code = ev.data().gateCode;
  const passes = await getDocs(collection(db, COL, id, "passes"));
  const roster = await getDocs(collection(db, GATES, code, "roster"));
  const claims = await getDocs(collection(db, GATES, code, "claims"));
  const repeatRefs = [];
  for (const c of claims.docs) {
    const reps = await getDocs(collection(db, GATES, code, "claims", c.id, "repeats"));
    repeatRefs.push(...reps.docs.map((d) => d.ref));
  }
  const refs = [
    doc(db, COL, id),
    doc(db, "gp_users", auth.currentUser.uid, "events", id),
    doc(db, GATES, code),
    ...passes.docs.map((d) => d.ref),
    ...roster.docs.map((d) => d.ref),
    ...claims.docs.map((d) => d.ref),
    ...repeatRefs,
    ...passes.docs.map((d) => doc(db, PASS_PUB, d.data().token)),
  ];
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db);
    refs.slice(i, i + 400).forEach((r) => batch.delete(r));
    await batch.commit();
  }
}
```

- [ ] **Step 3: Commit** — `git add assets/js/firebase.js && git commit -m "feat(firebase): init, auth and event data layer"`

---

## Task 4 — Data layer: passes, code rotation, gate join/find/stats

**Files:** Modify `assets/js/firebase.js`

- [ ] **Step 1: Pass generation and reads** — append:

```js
export async function getPasses(eventId) {
  const snap = await getDocs(collection(db, COL, eventId, "passes"));
  return snap.docs.map((d) => {
    const p = d.data();
    return {
      id: d.id, name: p.name, contact: p.contact || "", token: p.token,
      created_at: stamp(p.createdAt) || "",
    };
  });
}

export async function generatePasses(eventId, rows, eventSnapshot) {
  // Never persist the gate code in a publicly readable pass document.
  const { gateCode, ...publicEvent } = eventSnapshot;
  for (let i = 0; i < rows.length; i += 400) {
    const batch = writeBatch(db);
    for (const p of rows.slice(i, i + 400)) {
      const passId = doc(collection(db, COL, eventId, "passes")).id;
      const token = newToken();
      batch.set(doc(db, COL, eventId, "passes", passId), {
        name: p.name, contact: p.contact || "", token,
        createdAt: serverTimestamp(), checkedInAt: null, gate: "",
      });
      batch.set(doc(db, PASS_PUB, token), {
        id: passId, eventId, name: p.name, event: publicEvent,
        checkedInAt: null, gate: "",
      });
      batch.set(doc(db, GATES, gateCode, "roster", passId), {
        name: p.name, nameLower: p.name.toLowerCase(),
        hint: mask(p.contact), token, checkedInAt: null, gate: "",
      });
    }
    batch.update(doc(db, COL, eventId), { total: increment(rows.slice(i, i + 400).length) });
    batch.update(doc(db, GATES, gateCode), { total: increment(rows.slice(i, i + 400).length) });
    await batch.commit();
  }
}

function mask(contact = "") {
  if (!contact) return "";
  if (contact.includes("@")) {
    const i = contact.indexOf("@");
    return contact.slice(0, 2) + "•••" + contact.slice(i);
  }
  return "•••" + contact.replace(/\D/g, "").slice(-4);
}

export async function getPassByToken(token) {
  const s = await getDoc(doc(db, PASS_PUB, token));
  if (!s.exists()) return null;
  const p = s.data();
  return {
    name: p.name, event: p.event,
    checked_in_at: stamp(p.checkedInAt), gate: p.gate || "",
  };
}
```

`eventSnapshot` must include `gateCode` (the organiser passes `state.ev.gate_code`), because roster and gate-counter writes are addressed by code.

- [ ] **Step 2: Code rotation** — append:

```js
export async function rotateCode(eventId, oldCode) {
  const next = newCode();
  // Read the roster while the old gate doc still exists — rules gate reads on its existence.
  const roster = await getDocs(collection(db, GATES, oldCode, "roster"));
  const rows = roster.docs.map((d) => ({ id: d.id, data: d.data() }));
  const claimSnap = await getDocs(collection(db, GATES, oldCode, "claims"));
  const claims = [];
  for (const c of claimSnap.docs) {
    const reps = await getDocs(collection(db, GATES, oldCode, "claims", c.id, "repeats"));
    claims.push({ id: c.id, data: c.data(), repeats: reps.docs.map((r) => r.data()) });
  }
  const evRef = doc(db, COL, eventId);

  // ORDER MATTERS. Subcollection writes authorize by looking up a gate doc at the
  // code in the path. Both gate docs must exist while we migrate, so delete the
  // old gate doc LAST — otherwise the migration writes are denied and the claims
  // are lost, which would let every pass be scanned as "first" again.
  await runTransaction(db, async (tx) => {
    const ev = await tx.get(evRef);
    if (!ev.exists() || ev.data().gateCode !== oldCode) throw new Error("Code changed");
    const oldGate = await tx.get(doc(db, GATES, oldCode));
    tx.set(doc(db, GATES, next), {
      eventId, total: oldGate.data().total || 0,
      checked: oldGate.data().checked || 0, bounced: oldGate.data().bounced || 0,
      recent: oldGate.data().recent || [],
    });
    tx.update(evRef, { gateCode: next });
    // no delete here
  });

  // Rewrite roster, claims and repeats under the new code, then remove old docs.
  for (let i = 0; i < rows.length; i += 400) {
    const batch = writeBatch(db);
    for (const r of rows.slice(i, i + 400)) {
      batch.set(doc(db, GATES, next, "roster", r.id), r.data);
      batch.delete(doc(db, GATES, oldCode, "roster", r.id));
    }
    await batch.commit();
  }
  for (const c of claims) {
    const batch = writeBatch(db);
    batch.set(doc(db, GATES, next, "claims", c.id), c.data);
    batch.delete(doc(db, GATES, oldCode, "claims", c.id));
    for (const r of c.repeats) batch.set(doc(collection(db, GATES, next, "claims", c.id, "repeats")), r);
    await batch.commit();
  }
  // Now that nothing points at the old code, remove it.
  await deleteDoc(doc(db, GATES, oldCode));
  return next;
}
```

Note: `gp_gates/{code}` carries `total`, `checked`, `bounced` and a `recent` array. `total` is maintained by the owner; Security Rules restrict unauthenticated staff to `checked`/`bounced`/`recent` only. Tasks 2's follow-up fix already applied that rule change.

- [ ] **Step 3: Gate join, stats, find** — append:

```js
export async function joinGate(code) {
  const s = await getDoc(doc(db, GATES, code));
  if (!s.exists()) return null;
  const d = s.data();
  // Gate staff are unauthenticated: read everything from the gate doc, never gp_events.
  return {
    event_id: d.eventId, name: d.name, club: d.club || "",
    starts_at: stamp(d.startsAt), venue: d.venue || "", art: d.art || 0,
    counts: { total: d.total || 0, checked: d.checked || 0, bounced: d.bounced || 0 },
  };
}

let statsUnsub = null, statsCode = null;
export function gateStats(code) {
  if (statsUnsub && statsCode === code) return;   // idempotent; scans call this often
  if (statsUnsub) statsUnsub();
  statsCode = code;
  statsUnsub = onSnapshot(doc(db, GATES, code), (s) => {
    if (!s.exists()) return;
    const d = s.data();
    window.dispatchEvent(new CustomEvent("gp-stats", { detail: {
      counts: { total: d.total || 0, checked: d.checked || 0, bounced: d.bounced || 0 },
      recent: d.recent || [],
    }}));
  });
}

export async function gateFind(code, text) {
  const q = text.trim().toLowerCase();
  if (q.length < 2) return [];
  const s = await getDocs(query(
    collection(db, GATES, code, "roster"),
    where("nameLower", ">=", q), where("nameLower", "<=", q + "\uf8ff"), limit(8)));
  return s.docs.map((d) => {
    const r = d.data();
    return {
      id: d.id, name: r.name, hint: r.hint, token: r.token,
      checked_in_at: stamp(r.checkedInAt), gate: r.gate || "",
    };
  });
}
```

Note: `total` must be maintained on `gp_events` — increment in `generatePasses`, decrement in `deleteEvent`/pass deletion. Add `total: increment(rows.length)` to the event doc write in `generatePasses` and `total: 0` in `createEvent`.

- [ ] **Step 4: Commit** — `git add assets/js/firebase.js && git commit -m "feat(firebase): passes, rotation, gate data functions"`

---

## Task 5 — Data layer: one-shot scan transaction

**Files:** Modify `assets/js/firebase.js`

- [ ] **Step 1: Append the shared scan**

```js
export async function scanToken(code, token, gateName, device) {
  const gateRef = doc(db, GATES, code);
  const passRef = doc(db, PASS_PUB, token);

  const gateSnap = await getDoc(gateRef);
  if (!gateSnap.exists()) return { status: "bad_code" };
  const passSnap = await getDoc(passRef);
  if (!passSnap.exists()) return { status: "unknown" };
  const pass = passSnap.data();
  if (pass.eventId !== gateSnap.data().eventId) return { status: "wrong_event" };

  const result = await runTransaction(db, async (tx) => {
    const g = await tx.get(gateRef);
    const p = await tx.get(passRef);
    const claimRef = doc(db, GATES, code, "claims", p.data().id);
    const existing = await tx.get(claimRef);
    const at = new Date().toISOString();
    const recent = [{ name: p.data().name, gate: gateName, is_first: !existing.exists(), at }];

    if (!existing.exists()) {
      tx.set(claimRef, {
        eventId: g.data().eventId, token, name: p.data().name,
        gate: gateName, device, scannedAt: serverTimestamp(),
      });
      tx.update(passRef, { checkedInAt: serverTimestamp(), gate: gateName });
      tx.update(doc(db, GATES, code, "roster", p.data().id),
        { checkedInAt: serverTimestamp(), gate: gateName });
      tx.update(gateRef, {
        checked: increment(1),
        recent: [recent[0], ...(g.data().recent || [])].slice(0, 6),
      });
      return { status: "ok", name: p.data().name, scanned_at: at, counts: countsOf(g.data()) };
    }

    tx.set(doc(collection(db, GATES, code, "claims", p.data().id, "repeats")), {
      eventId: g.data().eventId, gate: gateName, device, scannedAt: serverTimestamp(),
    });
    tx.update(gateRef, {
      bounced: increment(1),
      recent: [recent[0], ...(g.data().recent || [])].slice(0, 6),
    });
    // A serverTimestamp() written inside a transaction reads back as null, so take
    // the first-scan time/gate from the public pass doc, which was committed earlier.
    const firstAt = stamp(p.data().checkedInAt) || at;
    const firstGate = p.data().gate || "";
    const firstDevice = existing.data().device;
    return {
      status: "dup", name: p.data().name,
      first_at: firstAt, first_gate: firstGate,
      same_device: firstDevice === device && !!device,
      repeats: (g.data().bounced || 0) + 1,
      counts: countsOf(g.data()),
    };
  });
  return result;
}

function countsOf(d) {
  return { total: d.total || 0, checked: d.checked || 0, bounced: d.bounced || 0 };
}

export async function admitById(code, passId, gateName, device) {
  // Read the token from the code-scoped roster; owner-only pass docs are not readable by staff.
  const r = await getDoc(doc(db, GATES, code, "roster", passId));
  if (!r.exists()) return { status: "unknown" };
  return scanToken(code, r.data().token, gateName, device);
}
```

- [ ] **Step 2: Verify** — run `node --check assets/js/firebase.js` (syntax only; module imports need a browser). Expected: no syntax errors.

- [ ] **Step 3: Commit** — `git add assets/js/firebase.js && git commit -m "feat(firebase): atomic one-shot scan transaction"`

---

## Task 6 — Wire the organiser page

**Files:** Modify `assets/js/organiser.js`

- [ ] **Step 1: Replace imports and session variables** — line 2–6 become:

```js
import {
  configured, ART, artUrl, passUrl, gateUrl, fmtCode, fmtWhen, fmtTime, fmtDay, esc, plural,
  store, copyText, toast, download, qrSvg, I, paintIcons, DB_MSG, escT, typo,
} from "./core.js";
import * as fb from "./firebase.js";
```

Declare `let session = null; let live = null;` and remove `let sb` and `let pollTimer`.

- [ ] **Step 2: Replace `boot()`** (lines 33–52):

```js
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
```

- [ ] **Step 3: Replace `signInView()` and delete `checkInbox()`** (lines 77–145):

```js
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
```

- [ ] **Step 4: Replace `listView()`** (lines 149–181). Keep the two template-literal markup blocks (the `stubs` map and the final `view.innerHTML`) byte-for-byte; replace only the data-fetch header:

```js
async function listView() {
  document.title = "Your events · GatePass";
  view.innerHTML = `<div class="skeleton" style="height:220px"></div>`;
  try {
    const idx = await fb.listEvents(session.uid);
    const data = await Promise.all(idx.map(async (e) => {
      const full = await fb.getEvent(e.id);
      const gate = full ? await fb.joinGate(full.gate_code) : null;
      return {
        id: e.id, name: full?.name || e.name, club: full?.club || "",
        starts_at: full?.starts_at || e.starts_at, venue: full?.venue || "",
        art: full?.art || 0,
        total: gate?.counts.total || 0, checked: gate?.counts.checked || 0,
      };
    }));
    // existing `const now = Date.now();` and the stubs template follow here unchanged,
    // replacing `total`/`checked` reads with the fields above.
  } catch (e) { return fail(e); }
}
```

- [ ] **Step 5: Replace the remaining data calls** with these exact one-line substitutions:

| Old line | New |
|---|---|
| 196 `sb.from("gp_events").select("*").eq("id", id).maybeSingle()` | `const data = await fb.getEvent(id);` |
| 234 `sb.from("gp_events").insert(row)...` | `const data = { id: await fb.createEvent(row) };` |
| 234 `sb.from("gp_events").update(row)...` | `await fb.updateEvent(id, row); const data = { id };` |
| 311 `sb.from("gp_events").delete().eq("id", id)` | `await fb.deleteEvent(id)` |
| 263–266 `Promise.all([fetchAll("gp_passes"...), fetchAll("gp_scans"...])` | `const [passes] = await Promise.all([fb.getPasses(id)]);` then `const gate = await fb.joinGate(ev.gate_code);` |
| 271 `for (const s of scans) ... state.first.set(...)` | `state.first = new Map(); state.bounced = gate.counts.bounced; state.checked = gate.counts.checked;` |
| 465 `sb.rpc("gp_rotate_code", { p_event: ev.id })` | `const data = await fb.rotateCode(ev.id, ev.gate_code);` |
| 419 `sb.from("gp_passes").insert(batch).select(...)` | `await fb.generatePasses(state.ev.id, batch, { name: state.ev.name, club: state.ev.club, starts_at: state.ev.starts_at, venue: state.ev.venue, art: state.ev.art, gateCode: state.ev.gate_code });` — no rows returned; re-read with `fb.getPasses` (see note below) |
| 565–567 `sb.channel(...).on(...).subscribe()` | `fb.gateStats(id)` (the listener is wired in `startLive`, Step 6) |
| 569–578 `pollTimer = setInterval(...)` | delete the whole block |

In `generate()`, after all batches commit, call `state.passes = await fb.getPasses(state.ev.id)` before re-rendering, so `done` reflects the real count.

- [ ] **Step 6: Update `startLive(state)`** (lines 552–579):

```js
function startLive(state) {
  stopLive();
  const onStats = (e) => {
    const c = e.detail.counts;
    const changed = c.checked !== state.checked || c.bounced !== state.bounced;
    state.checked = c.checked;
    state.bounced = c.bounced;
    if (changed) { renderStat(state, true); renderList(state); }
  };
  window.addEventListener("gp-stats", onStats);
  live = () => window.removeEventListener("gp-stats", onStats);
  fb.gateStats(state.ev.gate_code);
}
function stopLive() { if (live) { live(); live = null; } }
```

Also change line 270's state initialiser to include `checked: gate.counts.checked`, and change `renderStat()` line 434 from `const checked = state.first.size` to:
```js
const checked = state.checked ?? state.first.size;
```
`state.first` remains useful for per-row "In 4:15 PM · Gate 1" stamps; it can stay empty in the Firebase version — the row stamps are a nice-to-have, not the counter.

- [ ] **Step 7: Verify** — load `/` in a browser with the emulator running. Expected: Google sign-in button, no Supabase references, no console errors.

- [ ] **Step 8: Commit** — `git add assets/js/organiser.js && git commit -m "feat(firebase): wire organiser page"`

---

## Task 7 — Wire the gate scanner

**Files:** Modify `assets/js/gate.js`

- [ ] **Step 1: Replace imports and `rpc` calls**

Line 2 becomes:

```js
import { configured, esc, typo, fmtTime, fmtCode, store, I, paintIcons, plural, DB_MSG } from "./core.js";
import * as fb from "./firebase.js";
import { Camera, decode, tokenFrom } from "./scanner.js";
```

- [ ] **Step 2: `scanToken()`** (lines 96–108):

```js
async function scanToken(token) {
  S.busy = true;
  try {
    const r = await fb.scanToken(S.code, token, S.gate, S.device);
    if (r.status === "bad_code") { sounds.warn(); return leave("The organiser changed this gate's code. Ask them for the new one."); }
    showResult(r);
  } catch (e) {
    sounds.warn();
    verdict("warn", /unavailable|network|deadline/i.test(e.code || "") ? "No connection" : "Couldn't check that pass",
      /unavailable|network|deadline/i.test(e.code || "") ? "Not checked. Don't let them in until a scan goes green." : esc(e.message));
    S.last.token = null;
  } finally { S.busy = false; }
}
```

- [ ] **Step 3: `loadStats()`** (lines 129–142) — replace polling with the Firestore listener:

```js
function loadStats() {
  if (!S.code) return;
  fb.gateStats(S.code);
}
window.addEventListener("gp-stats", (e) => {
  setCounts(e.detail.counts);
  $("recent").innerHTML = e.detail.recent.length ? e.detail.recent.map((r) => `
    <li>
      <span class="${r.is_first ? "r-ok" : "r-dup"}">${r.is_first ? I.check : I.x}</span>
      <span class="r-name">${esc(r.name)}</span>
      <span class="r-at">${r.is_first ? "" : "repeat · "}${esc(r.gate)} · ${esc(fmtTime(r.at))}</span>
    </li>`).join("") : `<li><span class="r-at">Nobody scanned yet.</span></li>`;
});
```

Remove `S.statsTimer` and the `setInterval` in `showScanner()` (line 272) and the `clearInterval` in `leave()` (line 257).

- [ ] **Step 4: `join()`** (lines 275–292) — replace `rpc("gp_gate_join", {p_code})` with `fb.joinGate(code)`. Everything else (normalising the code, `store.set`, `showScanner`, camera permission) stays unchanged. In `boot()`, `configured` now comes from core; add `if (!configured || !fb.configured)` for the not-configured message.

- [ ] **Step 5: Find-by-name** — `rpc("gp_gate_find", ...)` → `fb.gateFind(S.code, q.value)` (lines 230+). The `rpc("gp_gate_admit", ...)` call at line 245 → `fb.admitById(S.code, b.dataset.id, S.gate, S.device)`, and handle `bad_code` the same way as `scanToken`.

- [ ] **Step 6: Verify** — with emulator seeded with one event/pass, join with the code; verdict idle, counter `0 / 1`.

- [ ] **Step 7: Commit** — `git add assets/js/gate.js && git commit -m "feat(firebase): wire gate scanner"`

---

## Task 8 — Wire the pass page and error mapping

**Files:** Modify `assets/js/pass.js`, `assets/js/core.js`

- [ ] **Step 1: `pass.js` imports and load**

```js
import { configured, esc, escT, typo, fmtWhen, fmtTime, qrSvg, setArt, passUrl, copyText, toast, I, ROOT, DB_MSG } from "./core.js";
import * as fb from "./firebase.js";
```

Replace the `rpc("gp_pass", ...)` block (lines 22–28):

```js
  let p;
  try { p = await fb.getPassByToken(token); }
  catch (e) {
    return missing("Couldn't load", esc(/unavailable|network|deadline/i.test(e.code || "") ? DB_MSG : e.message));
  }
```

Replace `if (!configured)` with `if (!configured || !fb.configured)`. Everything else in `render()` stays.

- [ ] **Step 2: Remove remaining Supabase strings** — grep the repo for `supabase`, `rpc(`, `PAUSED_MSG`, `sb.` and remove/fix all matches outside `vendor/` and the spec/plan docs. `DB_MSG` replaces `PAUSED_MSG` in any remaining message.

- [ ] **Step 3: Delete old backend files** — `git rm config.js schema.sql vendor/supabase.js`. Also remove `vendor/LICENSES.md` entries for supabase-js only if the file has them; keep other licences.

- [ ] **Step 4: Verify** — `/p/#bad` shows "No pass here"; `/p/#<valid 32-char token>` shows the ticket; no console errors.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(firebase): wire pass page, remove Supabase artifacts"`

---

## Task 9 — README

**Files:** Modify `README.md`

- [ ] **Step 1:** Replace all Supabase setup instructions with Firebase equivalents, referencing `SETUP.md`. Update the "Why a screenshot only works once" section to describe the Firestore claim doc and document-ID uniqueness. Update "Security model" to describe capability paths and Security Rules. Update the "Files" listing to the new file set. Update the local-run instruction (`python -m http.server 8000` still works; no allow-list needed for Firestore, only authorised domains for Google Auth).

- [ ] **Step 2: Fix the relative `og:image`** in `index.html` line 11 to an absolute URL for the hosted copy:

```html
<meta property="og:image" content="https://souradip121.github.io/gatepass/assets/art/crowd.jpg">
```

- [ ] **Step 3: Commit** — `git add README.md index.html && git commit -m "docs: Firebase README and absolute OG image"`

---

## Task 10 — Rules unit tests

**Files:** Create `tests/firestore.test.js`, `tests/package.json`

- [ ] **Step 1: Create `tests/package.json`**

```json
{
  "name": "gatepass-tests",
  "private": true,
  "type": "module",
  "scripts": { "test:rules": "node --test firestore.test.js" },
  "devDependencies": { "@firebase/rules-unit-testing": "^4.0.1", "firebase": "^11.10.0" }
}
```

- [ ] **Step 2: Create `tests/firestore.test.js`**

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { serverTimestamp } from "firebase/firestore";

const PROJECT = "gatepass-test", OWNER = "owner-uid", OTHER = "other-uid";
const EVENT = "event-1", CODE = "ABCD2345", TOKEN = "A".repeat(32), PASS = "pass-1";
let env;

const seed = () => env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await db.doc(`gp_events/${EVENT}`).set({ ownerId: OWNER, gateCode: CODE, total: 1, name: "Event" });
  await db.doc(`gp_users/${OWNER}/events/${EVENT}`).set({ name: "Event" });
  await db.doc(`gp_gates/${CODE}`).set({ eventId: EVENT, total: 1, checked: 0, bounced: 0, recent: [] });
  await db.doc(`gp_passes/${TOKEN}`).set({ id: PASS, eventId: EVENT, name: "Ada", checkedInAt: null, gate: "" });
  await db.doc(`gp_events/${EVENT}/passes/${PASS}`).set({ name: "Ada", contact: "ada@x.com", token: TOKEN });
  await db.doc(`gp_gates/${CODE}/roster/${PASS}`).set({ name: "Ada", nameLower: "ada", token: TOKEN });
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

const as = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const claim = () => ({
  eventId: EVENT, token: TOKEN, name: "Ada", gate: "Gate 1", device: "dev",
  scannedAt: serverTimestamp(),
});

test("owner reads own event, another user cannot", async () => {
  await seed();
  await assertSucceeds(as(OWNER).doc(`gp_events/${EVENT}`).get());
  await assertFails(as(OTHER).doc(`gp_events/${EVENT}`).get());
});
test("unauthenticated user cannot list gp_events", async () => {
  await seed();
  await assertFails(as(null).collection("gp_events").get());
  await assertSucceeds(as(OWNER).collection(`gp_users/${OWNER}/events`).get());
});
test("token is a read capability but collection list is denied", async () => {
  await seed();
  await assertSucceeds(as(null).doc(`gp_passes/${TOKEN}`).get());
  await assertFails(as(null).collection("gp_passes").get());
});
test("contact is absent from public pass, present in owner subcollection", async () => {
  await seed();
  const pub = (await as(OWNER).doc(`gp_passes/${TOKEN}`).get()).data();
  assert.equal(pub.contact, undefined);
  const priv = (await as(OWNER).doc(`gp_events/${EVENT}/passes/${PASS}`).get()).data();
  assert.equal(priv.contact, "ada@x.com");
});
test("first claim create succeeds with a valid code", async () => {
  await seed();
  await assertSucceeds(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).set(claim()));
});
test("second claim create for the same pass is denied", async () => {
  await seed();
  await as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).set(claim());
  await assertFails(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).set(claim()));
});
test("claim create under an unknown code is denied", async () => {
  await seed();
  await assertFails(as(null).doc(`gp_gates/ZZZZZZZZ/claims/${PASS}`).set(claim()));
});
test("claim cannot be updated or deleted", async () => {
  await seed();
  await as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).set(claim());
  await assertFails(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).update({ gate: "Gate 2" }));
  await assertFails(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).delete());
});
test("gate staff may update only counters/recent on gp_gates", async () => {
  await seed();
  await assertSucceeds(as(null).doc(`gp_gates/${CODE}`).update({ checked: 1 }));
  await assertFails(as(null).doc(`gp_gates/${CODE}`).update({ name: "Hacked" }));
});
test("gate staff cannot change the gate doc's eventId", async () => {
  await seed();
  await assertFails(as(null).doc(`gp_gates/${CODE}`).update({ eventId: "other-event" }));
});
test("roster is readable by code but not writable by staff", async () => {
  await seed();
  await assertSucceeds(as(null).collection(`gp_gates/${CODE}/roster`).get());
  await assertFails(as(null).doc(`gp_gates/${CODE}/roster/${PASS}`).update({ name: "X" }));
});
test("old code stops working after rotation", async () => {
  await seed();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`gp_gates/NEWCODE1`).set({ eventId: EVENT, total: 1, checked: 0, bounced: 0, recent: [] });
    await ctx.firestore().doc(`gp_gates/${CODE}`).delete();
  });
  await assertFails(as(null).doc(`gp_gates/${CODE}`).get());
  await assertSucceeds(as(null).doc(`gp_gates/NEWCODE1`).get());
});
```

- [ ] **Step 3: Run against the emulator** — start `firebase emulators:start --only firestore --project gatepass-test` in one terminal, then `cd tests && npm install && npm run test:rules`. Expected: all 12 pass. Fix rules until they do.

- [ ] **Step 4: Commit** — `git add tests && git commit -m "test: Firestore rules unit tests"`

---

## Task 11 — Browser E2E and final verification

**Files:** Create `tests/e2e/duplicate-scan.spec.js`

- [ ] **Step 1: Create the Playwright spec** with one test: seed an event + one pass via the emulator admin, open two browser contexts on `/gate/`, join both with the same code and different gate names, call `window.GatePassGate.handleText(passUrl)` on each, and assert:
  - first context verdict contains "First scan" and `ok` class
  - second context verdict contains "Already scanned" and `dup` class
  - the organiser counter shows `1 / 1`
  - repeat scans increment `bounced`

- [ ] **Step 2: Run** — `npx playwright test tests/e2e/duplicate-scan.spec.js`. Expected: PASS.

- [ ] **Step 3: Manual smoke** — with the real Firebase project: Google sign-in, create event, paste 3 rows, generate, copy link, open pass, join gate, scan pass (green), rescan (red), rotate code and confirm old code is rejected, delete event.

- [ ] **Step 4: Commit** — `git add tests/e2e && git commit -m "test: duplicate-scan E2E and final verification"`

---

## Self-review

- Every spec requirement maps to a task: data model → Tasks 2–4; rules → Task 2; scan invariant → Task 5; page wiring → Tasks 6–8; errors → Task 8; file changes → Tasks 1–9; testing → Tasks 10–11; setup → Task 2/9.
- No placeholders: all new files have complete code; mechanical replacements have exact mappings.
- Type consistency: `starts_at` (ISO string), `gate_code`, `checked_in_at`, `counts.total/checked/bounced`, `status` values (`ok`, `dup`, `wrong_event`, `unknown`, `bad_code`) match between `firebase.js` and the three UI modules.

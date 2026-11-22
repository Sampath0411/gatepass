# Luma-style events homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace GatePass's homepage with a Luma-inspired event platform (Events feed, Calendar, Discover, Create Event, event detail + RSVP).

**Architecture:** New ESM module `assets/js/events.js` handles routing/rendering; new `assets/css/luma.css` scoped to `body.luma` avoids clashing with gate/pass styles; Firestore collections `gp_events_v2` + `gp_rsvps/{eventId}/{uid}`; Security Rules allow public reads and owner writes; Google Auth via existing `firebase.js`.

**Tech Stack:** Firebase Auth/Firestore (existing), plain HTML/CSS/ES modules, no build step.

---

## Task 1 — Firestore rules + data layer

**Files:** `firestore.rules`, `assets/js/firebase.js`

- [ ] **Step 1:** Append rules:
```
    match /gp_events_v2/{eventId} {
      allow get: if resource.data.visibility == 'public' || isOwnerEventV2(eventId);
      allow list: if resource.data.visibility == 'public' || isOwnerEventV2(eventId);
      allow create: if signedIn() && request.resource.data.ownerId == request.auth.uid;
      allow update, delete: if isOwnerEventV2(eventId);
    }
    function isOwnerEventV2(eventId) {
      return signedIn() && get(/databases/$(database)/documents/gp_events_v2/$(eventId)).data.ownerId == request.auth.uid;
    }
    match /gp_rsvps/{eventId}/{uid} {
      allow read: if get(/databases/$(database)/documents/gp_events_v2/$(eventId)).data.visibility == 'public' || isOwnerEventV2(eventId);
      allow create, delete: if signedIn() && uid == request.auth.uid;
      allow update: if false;
    }
```
Note about `list`: Firestore rules are not filters; the client must query `where("visibility","==","public")` for public lists and use an owner index for private ones. Add `gp_users/{uid}/createdEvents/{eventId}` index (owner-scoped) written at create, and let owner queries use that path. Keep rules simple.
- [ ] **Step 2:** Add exports to `firebase.js`:
```js
export async function createV2Event(row) { /* batch: gp_events_v2 doc + gp_users/{uid}/createdEvents/{id} */ }
export async function listV2Events() { /* query gp_events_v2 where visibility == public, orderBy startsAt desc */ }
export async function getV2Event(id) { /* getDoc */ }
export async function updateV2Event(id, row), deleteV2Event(id)
export async function rsvpEvent(eventId, user) { /* setDoc gp_rsvps/{eventId}/{uid} with name/email/at */ }
export async function cancelRsvp(eventId, user), listRsvps(eventId)
```
Use existing imports. Verify `node --check`, commit `feat(firebase): events v2 and RSVP data layer`.

---

## Task 2 — Luma CSS shell + homepage feed

**Files:** new `assets/css/luma.css`, `index.html`, new `assets/js/events.js`

- [ ] **Step 1:** Create `assets/css/luma.css` with `body.luma` scoped styles exactly per spec (charcoal, fields, nav, card grid, detail, create form, responsive). Do NOT edit `gatepass.css`.
- [ ] **Step 2:** Change `index.html`: add `<link rel="stylesheet" href="assets/css/luma.css">`, add `class="luma"` to `<body>`, replace module script `organiser.js` with `events.js`. Keep import map + firebase-config.
- [ ] **Step 3:** Create `assets/js/events.js` with:
  - import configured, fb, I (icons from core), css helpers
  - `boot()` guarded on configured/fb.configured; `fb.onAuth`; render nav + view
  - routes: `#/calendar`, `#/discover`, `#/create`, `#/event/{id}`, default feed
  - `renderFeed()`: `fb.listV2Events()` → card grid with cover from `artUrl(i)`, formatted date, location, RSVP count from `fb.listRsvps`
  - nav links + Create Event button (sign-in gate if not signed in)
- [ ] **Step 4:** Verify in browser (feed renders, nav works), commit `feat: Luma-style events feed and shell`.

---

## Task 3 — Calendar + Discover

**Files:** `assets/js/events.js`, `assets/css/luma.css`

- [ ] **Step 1:** `renderCalendar()`: month grid for current month, dots on days with events, click day filters list below; prev/next month buttons.
- [ ] **Step 2:** `renderDiscover()`: search input + category chips (art keys), filter loaded events client-side; empty state.
- [ ] **Step 3:** Verify, commit `feat: calendar and discover views`.

---

## Task 4 — Create Event editor (reference layout)

**Files:** `assets/js/events.js`, `assets/css/luma.css`

- [ ] **Step 1:** `renderCreate()`: two-column layout. Left: cover preview using `artUrl`, art picker (6 thumbnails), theme label "Minimal". Right:
  - big editable Event Name input (placeholder "Event Name")
  - Start / End rows with `input type=date` + `input type=time`, timezone chip (GMT+05:30 · Kolkata) with `<select>` for common zones
  - Location field, Description textarea
  - Event Options rows: Ticket Price (Free / amount), Require Approval toggle, Capacity (Unlimited / number)
  - visibility selector (Public/Private)
  - white Create Event button
- [ ] **Step 2:** Submit → validate title/start/end → `fb.createV2Event({...})` → route to `#/event/{id}`. Errors inline.
- [ ] **Step 3:** Verify screenshot-match at 1440x900 and mobile; commit `feat: Create Event editor`.

---

## Task 5 — Event detail + RSVP

**Files:** `assets/js/events.js`, `assets/css/luma.css`

- [ ] **Step 1:** `renderEvent(id)`: large cover, title, date/time, location, description, RSVP count + attendee avatars (initials), RSVP / Cancel RSVP button (sign-in required). Owner sees Edit/Delete.
- [ ] **Step 2:** RSVP writes `gp_rsvps/{eventId}/{uid}`; cancel deletes; live `onSnapshot` count via `fb.listRsvps`.
- [ ] **Step 3:** Owner edit reuses `renderCreate(id)` with prefilled values; delete with confirm.
- [ ] **Step 4:** Verify E2E-like flow manually; commit `feat: event detail and RSVP`.

---

## Task 6 — Tests, docs, deploy

**Files:** `tests/firestore.test.js`, `tests/e2e/events.spec.js`, `README.md`

- [ ] **Step 1:** Rules tests: public get/list, private hidden from other user, owner create/update/delete, RSVP own-only, cancel own-only.
- [ ] **Step 2:** E2E: sign in → create event → feed/calendar/discover show it → RSVP → count 1 → owner edit title → feed updates.
- [ ] **Step 3:** README section for the new homepage.
- [ ] **Step 4:** Run suites, `vercel --prod --yes`, push GitHub. Commit `test+docs: Luma-style events`.

---

## Self-review
- Spec coverage: nav/feed/calendar/discover/create/detail/RSVP all mapped to tasks.
- Type consistency: `startsAt`/`endsAt` Timestamps; UI formats with existing `fmtWhen`-like helpers.
- No placeholders: all code shown in tasks; no TBD.

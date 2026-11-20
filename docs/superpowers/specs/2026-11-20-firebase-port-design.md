# GatePass → Firebase port — design spec

Date: 2026-11-20
Status: approved for implementation planning

## Goal

Port GatePass from Supabase to Firebase (Auth + Firestore + Security Rules) with **no change to the existing UI/UX**. All three pages — organiser dashboard, gate scanner, attendee pass — keep their current look, copy, and behaviour. The result remains a static, build-free site.

## Constraints and decisions

- **Firebase project:** `fest-website-8dcd7` (web config supplied by the user). The project is shared with a fest website, so **every Firestore collection is prefixed `gp_`**.
- **Plan:** Spark (free). Cloud Functions are therefore out; all logic runs in the browser with Firestore transactions and Security Rules.
- **Auth:** Google only, matching the current hosted copy. Attendees and gate staff remain unauthenticated.
- **SDK delivery:** Firebase modular ESM from Google's CDN via an import map in each HTML page. No bundler, no build step.
- **Analytics:** not used. The supplied `measurementId` is ignored (GatePass needs no tracking).
- **Data migration:** none. The old Supabase project is paused; start with an empty Firestore. Old registrations can be re-uploaded as CSV through the organiser UI.

## Data model

| Collection | Doc ID | Fields | Access |
|---|---|---|---|
| `gp_events` | auto ID | `ownerId`, `name`, `club`, `venue`, `art`, `startsAt`, `gateCode`, `createdAt` | owner CRUD only |
| `gp_gates` | 8-char gate code | `eventId`, `checked`, `bounced` | `get` if the doc exists (code capability); `list` denied; writes validate code against event |
| `gp_passes` | 32-char token | `id` (pass ID), `eventId`, `name`, `event` (display snapshot), `checkedInAt`, `gate` | `get` by token capability; `list`/writes owner only |
| `gp_private` | pass ID | `token`, `eventId`, `name`, `contact` | owner only |
| `gp_claims` | pass ID | `eventId`, `token`, `name`, `gate`, `device`, `scannedAt`, `code` | `create` with gate validation; no `update`/`delete`; owner may read |
| `gp_claims/{passId}/repeats` | auto ID | `eventId`, `gate`, `device`, `scannedAt`, `code` | `create` with gate validation; owner may read |
| `gp_gates/{code}/roster` | pass ID | `name`, `hint` (masked contact), `token`, `checkedInAt`, `gate` | read by code capability; written by owner |

Code rotation: create `gp_gates/{newCode}`, copy counters and rewrite the roster subcollection under the new code in batches, delete `gp_gates/{oldCode}`, update `gp_events/{eventId}.gateCode`. Old codes stop working immediately. (Roster rewrite is up to 5,000 docs, batched at 500.)

Tokens: 24 random bytes → 32 URL-safe chars (192 bits) via `crypto.getRandomValues`.
Gate codes: 8 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31^8 ≈ 8.5×10¹¹), unbiased rejection sampling.

## Security rules

Helper predicates:

- `isSignedIn()` — `request.auth != null`
- `isOwner(eventId)` — `isSignedIn() && get(gp_events/{eventId}).data.ownerId == request.auth.uid`
- `validGate(code, eventId)` — `exists(gp_gates/{code}) && get(gp_gates/{code}).data.eventId == eventId`
- `passMatches(token, passId, eventId)` — `get(gp_passes/{token}).data.id == passId && ...eventId == eventId`

Rules summary:

- `gp_events`: all reads/writes require `isOwner(eventId)`; create additionally requires `ownerId == request.auth.uid`.
- `gp_passes`: `allow get: if true` (unguessable token is the capability); `list` and all writes require `isOwner(eventId)`; `contact` is never stored here.
- `gp_private`: owner only.
- `gp_gates`: `get` allowed when the doc exists (the code in the path is the capability); `list` denied; create and delete require `isOwner(eventId)`. Owner may update any field. Unauthenticated gate staff may update only `checked`/`bounced`, with `eventId` unchanged and no other keys changed.
- `gp_claims/{passId}`: `create` only if `validGate(request.resource.data.code, request.resource.data.eventId)`, `passMatches(...)`, `!exists(...)`, and `request.resource.data.scannedAt == request.time`. The client writes `scannedAt` with `serverTimestamp()` — during rules evaluation a server timestamp equals `request.time`, so this forbids backdating. No `update`/`delete`. `read` for owner.
- `gp_claims/{passId}/repeats/{id}`: `create` only if `validGate(code, eventId)`; `read` for owner.
- `gp_gates/{code}/roster/{passId}`: `get`/`list` allowed when `gp_gates/{code}` exists; writes require `isOwner`.

The gate code is persisted in claim/repeat docs, but those docs are owner-readable only and gate staff already know the code — no new disclosure.

## One-shot scan flow

Shared by QR scans and "find by name" admits, implemented as one `runTransaction`:

1. Read `gp_claims/{passId}`.
2. Read `gp_gates/{code}`; confirm valid and `eventId` matches the pass.
3. No claim → `create` claim (doc ID = pass ID, `scannedAt: serverTimestamp()`), `update` `gp_passes/{token}` with `checkedInAt: serverTimestamp()` and `gate`, `update` `gp_gates/{code}` with `checked: increment(1)`. Verdict: **green**.
4. Claim exists → `create` repeat log, `update` `gp_gates/{code}` with `bounced: increment(1)`, read `gp_passes/{token}` for first time/gate. Verdict: **red** with time/gate/first-gate details.

Concurrency: two simultaneous transactions on the same pass conflict; Firestore retries; the retry sees the claim and returns red. Exactly one green. Rules enforce the invariant independently of the client.

## Error mapping

| Firestore code | User-facing message |
|---|---|
| `unavailable`, `deadline-exceeded`, network failure | "No connection" / "Couldn't check that pass" |
| `permission-denied` | "Not authorised" |
| `aborted` | automatic retry |
| other | existing generic error text |

Remove Supabase-specific `PAUSED_MSG` ("database asleep") — Firebase projects do not pause.

## File changes

- **New** `firebase-config.js` — `window.FIREBASE = { ...web config... }`.
- **New** `assets/js/firebase.js` — data layer with the same return shapes as the current RPCs: `createEvent`, `updateEvent`, `listEvents`, `getEvent`, `deleteEvent`, `generatePasses`, `rotateCode`, `joinGate`, `scanToken`, `admitById`, `gateFind`, `gateStats`, `getPass`, `subscribeScans`.
- **New** `firestore.rules`, `firestore.indexes.json`, `SETUP.md`.
- **Edited** `index.html`, `gate/index.html`, `p/index.html` — add import map, swap script includes.
- **Edited** `assets/js/core.js` — keep formatting, icons, toast, clipboard, QR helpers; remove Supabase RPC/bootstrap.
- **Edited** `assets/js/organiser.js`, `gate.js`, `pass.js` — replace data-layer calls only; keep all UI code.
- **Edited** `README.md` — Firebase setup instructions.
- **Removed** `vendor/supabase.js`, `schema.sql`, `config.js` (replaced by `firebase-config.js`).

## Testing (dev-only; shipped site stays build-free)

- Rules unit tests with `@firebase/rules-unit-testing` + Firestore emulator: owner-only event access; token-only pass read; claim create one-shot; no claim overwrite; gate-code validation; rotation invalidates old code; contact isolation.
- Playwright E2E against the emulator: two gate clients scan one pass — one green, one red; repeated scans log and count; find-by-name admit path.
- Manual checklist: Google sign-in, event create/edit/delete, CSV upload → generate passes, copy/export links, gate join/leave, camera + photo scan, code rotation.

## User setup steps (Firebase console)

1. Create/use the Firebase project; enable **Firestore Database** (production mode) and choose a region.
2. Enable **Authentication → Google**; add the deployed domain to **Authorised domains**.
3. Publish `firestore.rules` (Firebase CLI or console Rules tab).
4. Put the supplied web config into `firebase-config.js`.
5. Optional: deploy to **Firebase Hosting** (or keep GitHub Pages — the build-free site works on either).

## Out of scope

- Data migration from the old Supabase project.
- Cloud Functions / Blaze plan features.
- Email magic-link or email/password sign-in.
- Analytics, push notifications, SMS/email delivery.
- Any visual redesign of the existing pages.

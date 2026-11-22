# Multi-event fest + public registration — design spec (Phase A)

Date: 2026-11-22
Status: approved for implementation planning

## Goal

Turn GatePass from a single-event tool into a **fest platform**: one fest contains many sub-events, each with its own gate code, roster, one-shot claims and counter. Students sign in with Google, register for a sub-event through a public link, and receive that sub-event's pass immediately. Every registration is appended live to the organiser's Google Sheet directly from the organiser's browser via the Sheets API (no server, no Apps Script). The organiser sees all registrations across all sub-events in one table.

## Constraints and decisions

- **Firebase Spark (free)** — no Cloud Functions. All logic runs in the browser; Security Rules are the trust boundary.
- **Student sign-in:** Google (Firebase Auth), same project as organisers. No new auth provider.
- **Separate pass per sub-event** (user decision) — one registration = one pass = one QR for that sub-event.
- **Sheets write path:** direct Google Sheets API from the **organiser's** browser using Google Identity Services OAuth (user decision: no Apps Script, no server). A student's browser cannot write to the organiser's Sheet, so the organiser connects their Sheet once in the dashboard; an `onSnapshot` listener on `gp_fests/{festId}/registrations` appends each new row as it arrives (live while the dashboard is open). Registrations made while it is closed are caught up on next open. Each registration doc carries a `sheetSynced` flag (owner-only write) so rows are appended exactly once. Requires one Google OAuth client ID (Sheets scope) in config. **Residual risk:** the sub-event's gate code must be readable by the registration page to create its roster entry, so it lives in a signed-in-readable descriptor; a registered student can see their own event's code. Documented; fully hiding it needs Cloud Functions (Blaze).
- **Backward compatibility:** existing `gp_events` / `gp_gates` data remains accessible through the legacy single-event route; new fests use the new collections. No data migration.
- **Phase B (separate spec):** custom gate names, scan-history export, bulk pass-photo ZIP, offline PWA, custom poster upload, pass revocation, capacity warning. Capacity is stored in Phase A but only *enforced/warned* in Phase B.

## Data model (all names prefixed `gp_`)

| Collection | Doc ID | Fields | Access |
|---|---|---|---|
| `gp_fests` | auto ID | `ownerId`, `name`, `club`, `startsAt`, `venue`, `art`, `sheetId`, `sheetRange`, `createdAt` | owner CRUD |
| `gp_users/{uid}/fests` | fest ID | `{ name, startsAt }` index | path-scoped owner |
| `gp_fests/{festId}/events` | auto ID | `festId`, `name`, `club`, `venue`, `art`, `startsAt`, `gateCode`, `registrationOpen`, `capacity`, `total`, `checked`, `bounced`, `recent`, `createdAt` | owner CRUD |
| `gp_reg_public` | event ID | `{ festId, name, club, venue, art, startsAt, gateCode, registrationOpen, capacity, total }` | `get` if `request.auth != null`; no `list`; owner writes |
| `gp_fests/{festId}/events/{eventId}/passes` | pass ID | full pass: `name`, `contact`, `token`, `uid`, `registrationId`, `createdAt`, `checkedInAt`, `gate` | owner read; student `create` only |
| `gp_fests/{festId}/registrations` | auto ID | unified row: `eventId`, `eventName`, `name`, `email`, `phone`, `uid`, `passId`, `token`, `createdAt`, `sheetSynced` | owner read/update; student `create` only |
| `gp_passes` | 32-char token | public projection: `id`, `festId`, `eventId`, `event` (display snapshot, **no** `gateCode`), `name`, `checkedInAt`, `gate` | `get: true`; owner-only update; student `create` |
| `gp_gates/{code}` | code | `eventId`, `festId`, display fields, `total`, `checked`, `bounced`, `recent` | `get` if exists; staff counter updates; owner create/delete |
| `gp_gates/{code}/roster` | pass ID | `{ name, nameLower, hint, token, checkedInAt, gate }` | read by code; owner update; student `create` |
| `gp_gates/{code}/claims` + `repeats` | pass ID / auto | unchanged one-shot claim + repeat log | unchanged rules |

`gp_reg_public` is the only new publicly readable collection; it is the registration page's descriptor and is never listed.

## Flows

**Fest creation:** organiser signs in → "New fest" → writes `gp_fests/{id}` + `gp_users/{uid}/fests/{id}` in one batch → fest page.

**Sub-event creation:** organiser adds a sub-event → generates gate code → writes event doc + `gp_gates/{code}` + `gp_reg_public/{eventId}` in one batch (rules use `getAfter` on the event, as established in the earlier port).

**Registration (student):**
1. Student opens `#/register/{eventId}` → Google sign-in if needed.
2. Reads `gp_reg_public/{eventId}` for name, fields, and `registrationOpen`.
3. Fills name / email / phone (plus any Phase B custom fields). On submit, one `writeBatch` creates: the full pass doc, the unified registration doc, the public `gp_passes/{token}` doc, and `gp_gates/{code}/roster/{passId}`. Rules validate: signed in, `uid == request.auth.uid`, descriptor `registrationOpen`, `capacity` not already reached (best-effort), token length ≥ 32, and code/wildcard match.
4. Student receives their pass URL immediately (pass page as today).
5. **Sheet sync (organiser side only):** the organiser connects their Google Sheet once via a Google OAuth token (Sheets scope) in the fest settings. An `onSnapshot` on `gp_fests/{festId}/registrations` finds docs with `sheetSynced != true`, appends their rows to the Sheet through `sheets.spreadsheets.values.append`, then writes `sheetSynced: true` (owner-only). Rows created while the dashboard was closed are synced on next open. A failed append is retried on the next snapshot with a visible warning; it never affects registration or scanning.

**Organiser unified view:** fest page has an "All registrations" tab reading `gp_fests/{festId}/registrations` (owner-only), grouped/filterable by sub-event, with CSV export.

**Gate scanning:** unchanged — staff join with the sub-event's gate code; the one-shot claim doc enforces exactly one accepted scan per pass; find-by-name and counters work as today (including the recent security fixes).

## Google Sheets connection (no script, no server)

- Add `googleOAuthClientId` to `firebase-config.js` (Google Cloud → APIs & Services → Credentials → OAuth client ID, type Web application; authorised JavaScript origin = the deployed domain). Add the same domain to the OAuth consent screen.
- `assets/js/sheets.js`: dynamically load `https://accounts.google.com/gsi/client`; `initTokenClient` with scope `https://www.googleapis.com/auth/spreadsheets`; `requestAccessToken()` opens consent once, silent renewal with `prompt: 'none'`; token kept in memory only.
- Parse the spreadsheet ID from a pasted Sheet URL (or accept the ID directly); optional range (default `Registrations` or `Sheet1`).
- Append rows with `POST https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}:append?valueInputOption=USER_ENTERED`, body `{ values: [[...]] }`, `Authorization: Bearer <token>`.
- Columns: `timestamp, fest, sub-event, name, email, phone, pass URL`.
- CSP updates in `vercel.json`/`firebase.json`: add `https://accounts.google.com` to `script-src`, `https://sheets.googleapis.com` to `connect-src`.

## Error handling

| Case | Behaviour |
|---|---|
| Not signed in | "Sign in with Google to register" button |
| `registrationOpen === false` | "Registration is closed for this event" |
| Full (`total >= capacity`) | "This event is full" (best-effort in rules; enforced in Phase B) |
| Firestore write fails | Inline error, form stays filled |
| Sheet token missing/expired | Organiser sees "Connect Google Sheet" button; registration unaffected |
| Sheet append fails | Warning on fest dashboard; the row stays `sheetSynced: false` and retries on next snapshot |
| Invalid/expired descriptor | "This registration link is no longer valid" |

## Files

- **New** `assets/js/sheets.js`, `assets/js/register.js`, `register/index.html`
- **New** `docs/.../plans/` Phase A plan (next step)
- **Edited** `firestore.rules`, `assets/js/firebase.js`, `assets/js/organiser.js`, `assets/js/core.js`, `assets/css/gatepass.css`, `index.html`, `README.md`, `SETUP.md`

## Testing

- Rules unit tests: descriptor signed-in `get` / no `list`; student can create own pass+registration+roster but not someone else's; owner-only reads of unified registration; registration blocked when closed; no `gateCode` in public pass doc.
- E2E: create fest → create two sub-events → two students register → organiser sees both rows → Sheets append is stubbed and both rows are appended exactly once (`sheetSynced` flips) → each pass scans green once and red on repeat at its own gate.

## Out of scope (Phase B)

Custom gate names, scan-history CSV, bulk pass-photo ZIP, offline PWA, custom poster upload, pass revocation/reissue, capacity *warning* UI and hard enforcement.

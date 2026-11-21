# Multi-event fest + public registration — design spec (Phase A)

Date: 2026-11-22
Status: approved for implementation planning

## Goal

Turn GatePass from a single-event tool into a **fest platform**: one fest contains many sub-events, each with its own gate code, roster, one-shot claims and counter. Students sign in with Google, register for a sub-event through a public link, and receive that sub-event's pass immediately. Every registration is appended live to the organiser's Google Sheet via a small Apps Script web app they host themselves. The organiser sees all registrations across all sub-events in one table.

## Constraints and decisions

- **Firebase Spark (free)** — no Cloud Functions. All logic runs in the browser; Security Rules are the trust boundary.
- **Student sign-in:** Google (Firebase Auth), same project as organisers. No new auth provider.
- **Separate pass per sub-event** (user decision) — one registration = one pass = one QR for that sub-event.
- **Sheets write path:** Google Apps Script web app (user decision). A short `apps-script/Code.gs` is provided; the organiser deploys it once from their own Sheet and pastes the web-app URL into GatePass. The Apps Script URL and the sub-event's gate code must be readable by the registration page, so both live in a signed-in-readable "registration descriptor" doc. **Residual risk:** any signed-in student who opens the registration link can see that sub-event's gate code and Sheet webhook. This is documented in the README; fully hiding them would require Cloud Functions (Blaze).
- **Backward compatibility:** existing `gp_events` / `gp_gates` data remains accessible through the legacy single-event route; new fests use the new collections. No data migration.
- **Phase B (separate spec):** custom gate names, scan-history export, bulk pass-photo ZIP, offline PWA, custom poster upload, pass revocation, capacity warning. Capacity is stored in Phase A but only *enforced/warned* in Phase B.

## Data model (all names prefixed `gp_`)

| Collection | Doc ID | Fields | Access |
|---|---|---|---|
| `gp_fests` | auto ID | `ownerId`, `name`, `club`, `startsAt`, `venue`, `art`, `sheetWebhook`, `createdAt` | owner CRUD |
| `gp_users/{uid}/fests` | fest ID | `{ name, startsAt }` index | path-scoped owner |
| `gp_fests/{festId}/events` | auto ID | `festId`, `name`, `club`, `venue`, `art`, `startsAt`, `gateCode`, `registrationOpen`, `capacity`, `total`, `checked`, `bounced`, `recent`, `createdAt` | owner CRUD |
| `gp_reg_public` | event ID | `{ festId, name, club, venue, art, startsAt, gateCode, sheetWebhook, registrationOpen, capacity, total }` | `get` if `request.auth != null`; no `list`; owner writes |
| `gp_fests/{festId}/events/{eventId}/passes` | pass ID | full pass: `name`, `contact`, `token`, `uid`, `registrationId`, `createdAt`, `checkedInAt`, `gate` | owner read; student `create` only |
| `gp_fests/{festId}/registrations` | auto ID | unified row: `eventId`, `eventName`, `name`, `email`, `phone`, `uid`, `passId`, `token`, `createdAt` | owner read; student `create` only |
| `gp_passes` | 32-char token | public projection: `id`, `festId`, `eventId`, `event` (display snapshot, **no** `gateCode`/webhook), `name`, `checkedInAt`, `gate` | `get: true`; owner-only update; student `create` |
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
4. After the batch commits, POST `{ fest, event, name, email, phone, token, passUrl, at }` to `sheetWebhook` with `Content-Type: text/plain` (avoids CORS preflight). A failed POST shows "Registration saved — Sheet sync failed, retry" but never rolls back the registration.
5. Student receives their pass URL immediately (pass page as today).

**Organiser unified view:** fest page has an "All registrations" tab reading `gp_fests/{festId}/registrations` (owner-only), grouped/filterable by sub-event, with CSV export.

**Gate scanning:** unchanged — staff join with the sub-event's gate code; the one-shot claim doc enforces exactly one accepted scan per pass; find-by-name and counters work as today (including the recent security fixes).

## Apps Script (`apps-script/Code.gs`)

```
function doPost(e) {
  const p = JSON.parse(e.postData.contents);
  SpreadsheetApp.getActiveSheet().appendRow([
    new Date(), p.fest || '', p.event || '', p.name || '',
    p.email || '', p.phone || '', p.token || '', p.passUrl || ''
  ]);
  return ContentService.createTextOutput('ok');
}
```
Deploy → New deployment → Web app → Execute as **me**, Access: **Anyone**. The URL goes into the fest settings field. Document rotation: redeploy with a new URL and replace the value.

## Error handling

| Case | Behaviour |
|---|---|
| Not signed in | "Sign in with Google to register" button |
| `registrationOpen === false` | "Registration is closed for this event" |
| Full (`total >= capacity`) | "This event is full" (best-effort in rules; enforced in Phase B) |
| Firestore write fails | Inline error, form stays filled |
| Sheet POST fails | Registration kept; warning + retry button |
| Invalid/expired descriptor | "This registration link is no longer valid" |

## Files

- **New** `apps-script/Code.gs`, `assets/js/register.js`, `register/index.html`
- **New** `docs/.../plans/` Phase A plan (next step)
- **Edited** `firestore.rules`, `assets/js/firebase.js`, `assets/js/organiser.js`, `assets/js/core.js`, `assets/css/gatepass.css`, `index.html`, `README.md`, `SETUP.md`

## Testing

- Rules unit tests: descriptor signed-in `get` / no `list`; student can create own pass+registration+roster but not someone else's; owner-only reads of unified registration; registration blocked when closed/full; no `gateCode` in public pass doc.
- E2E: create fest → create two sub-events → two students register → organiser sees both rows → Sheet webhook receives two POSTs (stubbed) → each pass scans green once and red on repeat at its own gate.

## Out of scope (Phase B)

Custom gate names, scan-history CSV, bulk pass-photo ZIP, offline PWA, custom poster upload, pass revocation/reissue, capacity *warning* UI and hard enforcement.

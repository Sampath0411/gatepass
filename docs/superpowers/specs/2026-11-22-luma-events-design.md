# Luma-style events homepage — design spec

Date: 2026-11-22
Status: approved for implementation

## Goal
Replace the current organiser-only homepage with a Luma-inspired event platform: top nav (Events / Calendars / Discover / Create Event), event card feed, month calendar, discovery search, event detail with RSVP, and the Create Event editor shown in the reference image. Keep all existing GatePass routes (`gate/`, `p/`, `register/`, `#/fest/...`, legacy `#/e/...`) working.

## Constraints
- No Luma logos, fonts, or proprietary artwork. Use the existing bundled poster art (`assets/art/*.jpg`) and CSS/system fonts.
- Same Firebase project, Spark plan, no Cloud Functions.
- Google sign-in reused; organiser identity = `auth.currentUser`.
- Existing dark palette stays for gate/pass/register; the new homepage uses the Luma-like charcoal/white look in its own CSS block.

## Data model (`gp_events_v2`)
| Field | Type | Notes |
|---|---|---|
| id | auto | doc ID |
| ownerId | string | Firebase uid |
| title | string | required, ≤ 120 |
| cover | string | `crowd`, `dj`, `mic`, `dance`, `band`, `hack` (existing art) or custom URL |
| startsAt / endsAt | Timestamp | from date+time inputs |
| timezone | string | e.g. `GMT+05:30` display label; stored as `Asia/Kolkata` if selected |
| location | string | free text / link |
| description | string | multiline |
| price | string | `Free` or an amount |
| approval | boolean | require approval |
| capacity | number | 0 = unlimited |
| visibility | `public` \| `private` | public listed in Discover |
| rsvps | array/object | `{ uid, name, email, at }` — for attendee counts and RSVP |
| createdAt | Timestamp | |

Rules: anyone signed in can `get` public events; `list` allowed only for public events via `where("visibility","==","public")` (query-based rule) plus owner's private events via an owner index. Owner-only create/update/delete. RSVP: signed-in user can add/remove only their own RSVP entry (appointment via field path or a `gp_rsvps` subcollection). Use `gp_rsvps/{eventId}/{uid}` subcollection — simpler rules: read if event public or owner, create/delete if uid == request.auth.uid. Attendee count via `getDocs` on subcollection (small scale) or stored `attendeeCount` incremented atomically — use subcollection getDocs for correctness.

## Pages/routes
- `/` → Events feed (default) or Calendar/Discover via hash `#/calendar`, `#/discover`
- `#/event/{id}` → detail + RSVP
- `#/create` → Create Event editor (reference layout)
- Existing organiser `#/fest/...`, `#/e/...`, gate/pass/register unchanged

## UI details (reference match)
- Top nav: 44px height, left links with tiny icons, right clock + Create Event + bell + avatar.
- Background `#1F1F1F`, cards/fields `#2C2C2C`, text `#ECECEC`, muted `#9A9A9A`, accent pink `#E85C9A` for small dots/links, primary button `#FFFFFF` with black text.
- Feed: 3-column grid on desktop, 1 on mobile; tall poster cards with title overlay, date/time, location, avatar stack.
- Calendar: 7-column month grid, day cells with event dots; clicking a day filters the list below.
- Discover: search input + category chips; filter client-side over loaded public events.
- Create Event: left 340px cover card with preview + theme selector; right form with big white Create Event button; fields exactly as reference (start/end rows, timezone, location, description, options).

## Files
- New `assets/js/events.js`, `assets/css/luma.css`
- New `assets/js/event-create.js` (or combined in events.js if < 400 lines)
- Modify `index.html` (module + stylesheet), `assets/js/core.js` (route helpers only if needed), `firestore.rules`, `README.md`
- Reuse `assets/art/*` covers; no new raster assets

## Testing
- Rules: public list/get, owner create/update/delete, RSVP own-only, private event hidden.
- E2E: sign in → create event → appears in feed/calendar/discover → RSVP → attendee count increments → owner can see RSVPs.

## Out of scope
Payments, actual ticket issuance from this flow (GatePass remains separate), notifications, custom image upload.

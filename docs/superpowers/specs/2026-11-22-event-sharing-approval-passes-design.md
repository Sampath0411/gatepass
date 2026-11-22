# Event sharing, link-only privacy, approval workflow and QR passes — design spec

Date: 2026-11-22
Status: approved for implementation

## Goal
Share events; public events appear in the feed, private events are reachable only by direct link; optional host approval with pending/approve/reject; every approved member gets a QR pass; one gate code per event works with the existing `/gate/` scanner (first scan green, repeats red).

## Decisions
- Private = link-only capability: anyone with the long unguessable event URL can open/register; hidden from Events/Calendar/Discover (user decision).
- Approval: pending → host approves → pass created automatically; rejected can resubmit (user decision).
- One gate code per event, existing scanner and one-shot claim model (user decision).

## Data changes
- `gp_events_v2/{id}`: add `gateCode` (8 chars, generated at create), `approvedCount` optional.
- `gp_rsvps/{eventId}/rsvps/{uid}`: add `status` (`approved`/`pending`/`rejected`), `passToken`, `passId`, `reviewedAt`, `reviewedBy`. Non-approval events default `approved`.
- `gp_passes/{token}` (existing public pass collection) gets a v2 pass when a member is approved: `{ id: uid, eventId: v2 event id, event: display snapshot (no gateCode), name, checkedInAt: null, gate: "" }` — the existing `/p/#<token>` page renders it unchanged.
- `gp_gates/{code}` (existing) created with the v2 event: `{ eventId: v2 event id, name, club, venue, art, startsAt, total, checked, bounced, recent }`.
- `gp_gates/{code}/roster/{uid}` created on approval with name/nameLower/hint/token so Find-by-name works.

## Rules
- `gp_events_v2` get: public OR any signed-in user (link-only private). `list`: public only (owner via index) — unchanged.
- `gp_rsvps` read: public event OR signed-in (link-only) OR owner. create own-only. update/delete owner-or-own (already).
- Add v2-owner grants for `gp_gates/{code}` create/update/delete, `gp_gates/{code}/roster` create/delete, and `gp_passes/{token}` create using `isOwnerEventV2(...)` via the gate/event doc. Legacy grants stay.
- Claims/repeats unchanged; their gate doc eventId is the v2 event id, so `passMatches` works.

## Flows
**Create event:** generate gateCode; batch event + owner index + `gp_gates/{code}` (or create gate lazily on first approval — prefer at create, with `getAfter` on the v2 event).
**Share:** event detail has a Share button (Web Share API with fallback to copy link) copying `#/event/{id}`.
**Register:** student RSVP form submit → `rsvpEvent`: if event.approval → status `pending`, no pass, UI shows "Awaiting approval"; else status `approved` + immediate pass/roster/gate writes.
**Host review:** Members table shows status and Approve/Reject for pending. `approveMember(eventId, uid)` batch: update rsvp status/passToken, create public pass, create roster, increment gate/event total. `rejectMember` sets status rejected. Rejected student can resubmit.
**Member:** event detail shows their status; approved shows "Open my pass" linking to `/p/#<token>`.
**Gate:** staff open `/gate/`, enter the event's gate code (shown on organiser event page with Copy link), scan passes as today.

## Files
`firestore.rules`, `assets/js/firebase.js`, `assets/js/events.js`, `assets/css/luma.css`, `tests/firestore.test.js`, `tests/e2e/events.spec.js`, `README.md`.

## Out of scope
Email notifications for approval/rejection; payments; per-sub-event gates.

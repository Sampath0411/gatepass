# Event member details + configurable registration fields — design spec

Date: 2026-11-22
Status: approved for implementation

## Goal
Let each event define which registration fields students fill (Name, Email, Phone, College, Year, Department, plus custom labels), collect those details on RSVP, and give the organiser a member directory with count, full table, CSV export, and edit/delete.

## Decisions
- Per-event `formFields` configured in the Create/Edit Event editor (user decision).
- RSVP opens the form; submitting it registers the member and marks them going (user decision).
- Organiser sees count + full table + CSV + edit/delete (user decision).
- Google sign-in still required; name/email prefilled from the Auth user.

## Data model changes
`gp_events_v2/{eventId}` adds:
```
formFields: [
  { key: "name", label: "Full name", type: "text", required: true, enabled: true },
  { key: "email", label: "Email", type: "email", required: true, enabled: true },
  ...
]
```
Defaults: name, email, phone, college (enabled; name/email required). Organiser can toggle enabled/required, rename labels, add custom fields (key = slug), remove custom fields.

`gp_rsvps/{eventId}/rsvps/{uid}` adds:
```
name, email, phone, college, answers: { [key]: value }, createdAt, updatedAt
```
(existing `at` kept). Rules change: `update`, `delete` allowed if `isOwnerEventV2(eventId) || uid == request.auth.uid`; `create` still uid-only.

## Flows
**Organiser:** Create/Edit Event → "Registration fields" section → save with event. Event detail → "Members (N)" section with search, table of all submitted fields, CSV export, Edit/Delete buttons per row.

**Student:** Event detail → "RSVP" opens modal form built from enabled formFields, prefilled from Google user (name/email). Required validation. Submit → `fb.rsvpEvent(eventId, user, answers)` → member appears, count increments. If already registered → "Edit my details" / "Cancel RSVP".

## Files
- `assets/js/firebase.js`: formFields in mapper/create/update; rsvpEvent(eventId,user,answers); updateRsvp(eventId,uid,answers); deleteRsvp(eventId,uid) (owner via rules).
- `assets/js/events.js`: form editor section, RSVP modal, members table + search + CSV + edit/delete.
- `assets/css/luma.css`: modal + table styles.
- `firestore.rules`: owner RSVP update/delete.
- Tests: rules tests for owner update/delete; E2E for configured fields → RSVP → organiser table/edit/CSV.

## Out of scope
Approval workflow enforcement, payments, email notifications, bulk member import.

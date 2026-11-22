# Security regression coverage (plan item 6, 23 Nov 2026)

This documents the emulator-backed coverage added for the 21–22 Nov security
fixes (commits `0306d47`, `be9aca2`). Run from `tests/`:

```
npm run test:rules
npm run test:e2e
```

## Firestore rules (`firestore.test.js`, 55 tests)

- **35** — a Phase A fest public pass requires a `registrationId` naming a
  registration written in the same batch, owned by the caller and carrying the
  same token. Missing, absent, foreign-uid and mismatched-token registrations
  are denied; a `gateCode` field on the pass is still refused.
- **40** — raw RSVPs are owner-or-self only: a signed-in link visitor can open
  a private event but cannot get or list another member's RSVP; anonymous reads
  are denied even on public events; the owner may read/list all. Attendee names
  come from `gp_members_public/{eventId}/m/{uid}`, which is world-readable and
  name-only, and writeable only by the member or the owner.
- **50** — pass forging is denied on approval events and on non-approval events
  whose RSVP is pending/rejected or absent; the approved own-RSVP batch (pass +
  token doc + roster row + single counter bump) succeeds.
- **51** — token docs are readable only by the member or the event owner; the
  token is never on the RSVP and cannot be minted for somebody else.
- **52** — a gate claim is denied while the pass's RSVP is pending/rejected,
  and succeeds once it is approved (one-shot claim still cannot be overwritten).
- **53** — a member may raise the gate `total` by exactly +1, only with an
  approved own RSVP; +2 is denied atomically.
- **54** — revoking an RSVP deletes the public pass, token doc, roster row,
  projection and RSVP in one batch, by the owner or by the member.
- **55** — event deletion cleans up gate-dependent docs first, then RSVPs, the
  event and owner index; a non-owner cannot delete the event.

## Browser E2E (`e2e/events.spec.js`)

- Non-owner and anonymous Firestore reads of raw RSVPs are asserted against the
  emulator rules via the rules test environment.
- Public attendee counts are verified to come from the name-only projection,
  including while an approval RSVP is still pending.
- The approval flow (pending → approval → pass link → QR → green/red scan) is
  unchanged; the token is now read from its separate doc.
- After the host removes the member, the pass/token/roster/projection are gone
  and the old QR scans "Not on the list" instead of green.

## Residual risk

Gate roster rows still carry the raw pass token and are readable by anyone with
the gate code (needed for the current phone-only find-by-name flow). Fully
hiding that token requires a server-side scan endpoint / Cloud Function.

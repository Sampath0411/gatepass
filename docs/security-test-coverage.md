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

## Addendum — stamp reliability + CSP repair (28 Nov 2026)

- **Claim-bound stamp projection (firestore.rules).** A new `gp_passes`
  update grant lets any caller write `checkedInAt`/`gate` only as an exact
  copy of an existing claim for that pass under its event's gate code, and
  only while the pass is unstamped (`stampMatchesClaim` + v1/v2/fest
  resolvers). The gate now projects the claim onto the pass doc at scan
  time, so the pass page stamps without the organiser dashboard being
  open. Forgery is impossible through the grant: both values are pinned
  to the claim, whose create rule is unchanged. Covered by
  `tests/stamp-diag.test.js` P1–P6 (exact copy succeeds signed-out; wrong
  time, wrong gate, already-stamped, extra field, missing claim all
  fail) — written for the emulator suite; run `npm run test:rules` where
  the emulator transport works. **Requires re-publishing firestore.rules**
  to take effect; under older published rules the projection write is
  denied and the dashboard mirror remains the backstop.
- **Mirror surfacing (organiser.js).** The dashboard stamp mirror runs
  before rendering, is awaited, retries unmarked passes, and reports
  failures (console + toast + a persistent hint in the stats box) instead
  of swallowing them — a denied mirror write previously looked exactly
  like success, which hid the Nov 27 stamp failure for three live tests.
- **CSP watchdog repair (vercel.json + page shells).** The CSP's second
  script hash matched nothing in the tree, so the inline clock/boot
  watchdog scripts on the organiser, gate, pass and register pages were
  blocked in production and the stuck-skeleton fallback never ran; its
  Reload button also used an inline `onclick` the CSP blocks. The
  watchdogs now wire their buttons with `addEventListener`, and the CSP
  pins the importmap hash plus all four page-script hashes.
- **Upload hardening (organiser.js).** The registrations file input now
  enforces the .csv/.tsv/.txt allowlist in code (the `accept` attribute
  is only a picker hint), catches read errors, and rejects NUL-byte
  binary content with a clean message. Size cap (4 MB) and row cap
  (5,000) were already in place.
- XSS surface re-audited end to end (events, organiser, gate, pass,
  register): every user-controlled interpolation goes through `esc`/
  `escT`; payload tests render inert in the fake-SDK browser harness.
  CSV exports already neutralised formula injection; the Sheets sync URL
  is pinned to `*.google.com` + `/spreadsheets/d/`.

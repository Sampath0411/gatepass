# Security fixes implementation plan

1. **Pass token separation:** new `gp_pass_tokens/{eventId}/{uid}` doc holds `passToken`; RSVP docs never hold it. Rules: read uid-or-owner; writes only in legitimate issue batches. Update firebase.js issue/approve/request/getMemberPass accordingly.
2. **RSVP privacy:** `gp_rsvps` read only owner or own uid. New `gp_members_public/{eventId}/m/{uid}` projection (name only) for public attendee counts/avatars. events.js non-owner member views use it.
3. **Pass forging closed:** replace broad signed-in `gp_passes` create grant with grants requiring (a) owner, (b) non-approval event + own approved RSVP + token doc in same batch, (c) Phase A fest registration with matching registrationId/uid/token. Claim create additionally requires RSVP status approved when an RSVP doc exists.
4. **Revocation:** reject/delete/cancel RSVP deletes pass, token and roster docs. Gate `total` member-update delta limited to +1.
5. **Event deletion:** delete pass/token/roster/gate docs before deleting the v2 event.
6. Tests: add emulator probes and unit/E2E regression cases for forging, token leakage, revocation, counter delta, cleanup. Publish rules, deploy, push.

# Event sharing, approval and QR passes Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development or executing-plans. Checkbox steps.

**Goal:** shareable link-only private events, host approval with reject/resubmit, QR pass per approved member, per-event gate code usable in the existing scanner.

---

## Task 1 — Rules + data layer

**Files:** `firestore.rules`, `assets/js/firebase.js`

- [ ] **Step 1:** Rules:
  - `gp_events_v2` get → `resource.data.visibility == 'public' || signedIn()`; list unchanged (public only).
  - `gp_rsvps` read → public event OR signedIn() OR owner; keep create/update/delete as-is.
  - Add second `allow create/update/delete` grants for `gp_gates/{code}` where `get(/gp_events_v2/$(request.resource.data.eventId)).data.gateCode == code` and owner matches (use `getAfter` for create batch). Keep all legacy grants.
  - Add v2-owner grant to `gp_gates/{code}/roster/{id}` create/delete (eventId lookup via gate doc → v2 event doc).
  - Add v2-owner grant to `gp_passes/{token}` create with keys hasOnly existing list.
- [ ] **Step 2:** firebase.js:
  - `createV2Event`: add `gateCode: newCode()`; batch also writes `gp_gates/{code}` with display fields + counters.
  - `v2Event()` maps `gate_code`.
  - `rsvpEvent(eventId, user, answers={})`: read event; set `status` to `pending` if approval else `approved`; if approved, in the SAME batch create pass + roster + increment gate total (helper `issuePassBatch`), set passToken on rsvp.
  - `approveMember(eventId, uid)`: read rsvp + event; set status approved, passToken, reviewedAt; issue pass + roster + counters; commit.
  - `rejectMember(eventId, uid)`: set status rejected + reviewedAt.
  - `requestPass(eventId)`: read own rsvp doc; return its status/passToken.
  - `getV2Event` unchanged (now readable signed-in).
- [ ] **Step 3:** node --check + emulator compile; commit `feat(firebase): sharing, approval and pass issuing`.

## Task 2 — Events UI

**Files:** `assets/js/events.js`, `assets/css/luma.css`

- [ ] **Step 1:** Event detail: add Share button (Web Share/copy link) on all events; for owner show gate code panel (code + Copy gate link) from `ev.gate_code`.
- [ ] **Step 2:** RSVP submit uses new rsvpEvent behavior; after submit show status: pending → "Awaiting approval" banner; rejected → "Request wasn't approved — you can update and resubmit"; approved → "Open my pass" link to `passUrl(passToken)`.
- [ ] **Step 3:** Members table: add Status column; for pending rows show Approve / Reject buttons calling fb.approveMember/rejectMember; refresh list and counts.
- [ ] **Step 4:** CSS for share button, status pills, gate panel.
- [ ] **Step 5:** Verify browser; commit `feat: share, approval UI and pass links`.

## Task 3 — Tests, docs, deploy

- [ ] Rules tests: private event get by signed-in non-owner allowed; list still excludes private; rsvp read link-only; owner approve/reject writes; only owner can approve/reject.
- [ ] E2E: create private+approval event → link opens for another signed-in user not in feed → request → pending → host approves → member sees pass link → pass page renders QR → gate join with code and scan green/red (reuse duplicate-scan harness pattern).
- [ ] README update. Run suites, publish rules, deploy, push. Commit `test+docs: sharing, approval and QR passes`.

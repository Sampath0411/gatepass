# Event members + configurable registration fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans. Use checkbox steps.

**Goal:** Per-event registration fields, RSVP form collecting details, organiser member directory with count/table/CSV/edit/delete.

---

## Task 1 — Rules + data layer

**Files:** `firestore.rules`, `assets/js/firebase.js`

- [ ] **Step 1:** In `match /gp_rsvps/{eventId}/rsvps/{uid}` change:
```
allow update: if isOwnerEventV2(eventId) || (signedIn() && uid == request.auth.uid);
allow delete: if isOwnerEventV2(eventId) || (signedIn() && uid == request.auth.uid);
```
Keep create uid-only; read unchanged.
- [ ] **Step 2:** In firebase.js:
  - `v2Event(doc)` add `formFields: d.data().formFields || DEFAULT_FORM_FIELDS` (define DEFAULT_FORM_FIELDS exported array of 4 fields name/email/phone/college with enabled/required/labels).
  - `createV2Event(row)` / `updateV2Event(id,row)` include `formFields: row.formFields || DEFAULT_FORM_FIELDS`.
  - `rsvpEvent(eventId, user, answers = {})` → set doc with `{ name, email, phone, college, answers, at: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() }` where values come from answers and user fallback.
  - Add `updateRsvp(eventId, uid, answers)` → updateDoc with answers + mapped fields + updatedAt.
  - Add `deleteRsvp(eventId, uid)` → deleteDoc.
- [ ] **Step 3:** Verify node --check + emulator compile; commit `feat(firebase): member fields and owner RSVP edit`.

## Task 2 — Create/Edit form fields UI

**Files:** `assets/js/events.js`, `assets/css/luma.css`

- [ ] **Step 1:** In `renderCreate(ev)`, after Event Options add "Registration fields" section: rows for each field with enabled checkbox, label input, required checkbox, key (hidden for preset); a text input + "Add field" button for custom fields; remove buttons for custom fields. State stored in module-level `state.formFields` (clone from ev or DEFAULT).
- [ ] **Step 2:** On submit include `formFields: state.formFields.filter(f=>f.enabled)`; for edit route prefill from `ev.formFields`.
- [ ] **Step 3:** CSS for `.l-fields`, `.l-field-row`.
- [ ] **Step 4:** Verify, commit `feat: per-event registration fields editor`.

## Task 3 — RSVP form modal

**Files:** `assets/js/events.js`, `assets/css/luma.css`

- [ ] **Step 1:** Build `openRsvpForm(ev, existing)` → modal with inputs for each enabled formField; prefill from existing answers or Google user (name/email); required validation; submit calls `fb.rsvpEvent` or `fb.updateRsvp`.
- [ ] **Step 2:** Event detail CTA: if not registered → "RSVP" opens modal; if registered → "Edit my details" opens modal + "Cancel RSVP" calls `fb.deleteRsvp`.
- [ ] **Step 3:** Modal styles (overlay, panel, close, error).
- [ ] **Step 4:** Verify, commit `feat: RSVP collects member details`.

## Task 4 — Organiser members directory

**Files:** `assets/js/events.js`, `assets/css/luma.css`

- [ ] **Step 1:** In `renderEvent(ev)` when owner, add "Members (N)" section with search input, table columns from enabled formFields + Joined at + actions, CSV export button using `toCsv` (import from csv.js) and `download` from core.
- [ ] **Step 2:** Edit button opens `openRsvpForm(ev, member)` in owner mode → `fb.updateRsvp`; Delete button confirms → `fb.deleteRsvp`.
- [ ] **Step 3:** Refresh via `fb.listRsvps(ev.id)` after writes; show empty state.
- [ ] **Step 4:** Verify, commit `feat: organiser member directory`.

## Task 5 — Tests, docs, deploy

- [ ] Rules tests: owner can update/delete any RSVP; member can update/delete own; non-owner cannot others'; create still own-only.
- [ ] E2E: configure fields → RSVP with details → organiser table shows count + row → edit row → CSV contains values.
- [ ] README update. Run suites, publish rules (`firebase deploy --only firestore:rules --project fest-website-8dcd7`), deploy Vercel, push GitHub. Commit `test+docs: event member details`.

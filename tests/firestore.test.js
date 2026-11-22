import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { serverTimestamp, runTransaction, writeBatch } from "firebase/firestore";

const PROJECT = "gatepass-test", OWNER = "owner-uid", OTHER = "other-uid";
const EVENT = "event-1", CODE = "ABCD2345", TOKEN = "A".repeat(32), PASS = "pass-1";
const REPEAT = `gp_gates/${CODE}/claims/${PASS}/repeats/repeat-1`;
let env;

const seed = () => env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await db.doc(`gp_events/${EVENT}`).set({ ownerId: OWNER, gateCode: CODE, total: 1, name: "Event" });
  await db.doc(`gp_users/${OWNER}/events/${EVENT}`).set({ name: "Event" });
  await db.doc(`gp_gates/${CODE}`).set({ eventId: EVENT, total: 1, checked: 0, bounced: 0, recent: [] });
  await db.doc(`gp_passes/${TOKEN}`).set({ id: PASS, eventId: EVENT, name: "Ada", checkedInAt: null, gate: "" });
  await db.doc(`gp_events/${EVENT}/passes/${PASS}`).set({ name: "Ada", contact: "ada@x.com", token: TOKEN });
  await db.doc(`gp_gates/${CODE}/roster/${PASS}`).set({ name: "Ada", nameLower: "ada", token: TOKEN });
});

// A pre-existing one-shot claim, for tests that need an already-claimed pass.
const seedClaim = () => env.withSecurityRulesDisabled(async (ctx) => {
  await ctx.firestore().doc(`gp_gates/${CODE}/claims/${PASS}`).set({
    eventId: EVENT, token: TOKEN, name: "Ada", gate: "Gate 1", device: "dev", scannedAt: new Date(),
  });
});

// An extra pass; the eventId can be overridden to build binding-mismatch cases.
const seedPass = (token, passId, eventId = EVENT) => env.withSecurityRulesDisabled(async (ctx) => {
  await ctx.firestore().doc(`gp_passes/${token}`).set({
    id: passId, eventId, name: "Ada", checkedInAt: null, gate: "",
  });
});

const seedRepeat = () => env.withSecurityRulesDisabled(async (ctx) => {
  await ctx.firestore().doc(REPEAT).set({
    eventId: EVENT, gate: "Gate 1", device: "dev", scannedAt: new Date(),
  });
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
beforeEach(async () => await seed());
afterEach(async () => env.clearFirestore());
after(async () => { await env.clearFirestore(); await env.cleanup(); });

const as = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const claim = () => ({
  eventId: EVENT, token: TOKEN, name: "Ada", gate: "Gate 1", device: "dev",
  scannedAt: serverTimestamp(),
});
const repeat = () => ({ eventId: EVENT, gate: "Gate 1", device: "dev", scannedAt: serverTimestamp() });

// ---- Base harness tests (1-12) ----

test("1. owner reads own event, another user cannot", async () => {
  await assertSucceeds(as(OWNER).doc(`gp_events/${EVENT}`).get());
  await assertFails(as(OTHER).doc(`gp_events/${EVENT}`).get());
});

test("2. unauthenticated user cannot list gp_events (owner can list user index)", async () => {
  await assertFails(as(null).collection("gp_events").get());
  await assertSucceeds(as(OWNER).collection(`gp_users/${OWNER}/events`).get());
});

test("3. token is a read capability but collection list is denied", async () => {
  await assertSucceeds(as(null).doc(`gp_passes/${TOKEN}`).get());
  await assertFails(as(null).collection("gp_passes").get());
});

test("4. contact is absent from public pass, present in owner subcollection", async () => {
  const pub = await as(null).doc(`gp_passes/${TOKEN}`).get();
  assert.equal(pub.data().contact, undefined);
  const priv = await as(OWNER).doc(`gp_events/${EVENT}/passes/${PASS}`).get();
  assert.equal(priv.data().contact, "ada@x.com");
});

test("5. first claim create succeeds with a valid code", async () => {
  await assertSucceeds(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).set(claim()));
});

test("6. staff cannot overwrite an existing claim via set()", async () => {
  await seedClaim();
  await assertFails(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).set(claim()));
});

test("7. claim create under an unknown code is denied", async () => {
  await assertFails(as(null).doc(`gp_gates/UNKNOWNCODE/claims/${PASS}`).set(claim()));
});

test("8. claim cannot be updated or deleted by staff", async () => {
  await seedClaim();
  await assertFails(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).update({ gate: "Hacked" }));
  await assertFails(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).delete());
});

test("9. gate staff may update only counters/recent on gp_gates (checked succeeds, name fails; also total fails)", async () => {
  await assertSucceeds(as(null).doc(`gp_gates/${CODE}`).update({ checked: 1 }));
  await assertFails(as(null).doc(`gp_gates/${CODE}`).update({ name: "X" }));
  await assertFails(as(null).doc(`gp_gates/${CODE}`).update({ total: 2 }));
});

test("10. gate staff cannot change the gate doc's eventId", async () => {
  await assertFails(as(null).doc(`gp_gates/${CODE}`).update({ eventId: "other-event" }));
});

test("11. roster is readable by code but not writable by staff", async () => {
  await assertSucceeds(as(null).doc(`gp_gates/${CODE}/roster/${PASS}`).get());
  await assertFails(as(null).doc(`gp_gates/${CODE}/roster/${PASS}`).update({ name: "X" }));
});

test("12. old code stops working after rotation (get nonexistent code fails)", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc(`gp_gates/NEWCODE1`).set({ eventId: EVENT, total: 1, checked: 0, bounced: 0, recent: [] });
    await db.doc(`gp_gates/${CODE}`).delete();
  });
  await assertFails(as(null).doc(`gp_gates/${CODE}`).get());
  await assertSucceeds(as(null).doc(`gp_gates/NEWCODE1`).get());
});

// ---- Additional tests for the tightened/extended rules (13-16) ----

test("13. backdated scannedAt: staff denied, owner allowed, different user denied", async () => {
  const backdated = new Date("2020-01-01");
  const T2 = "B".repeat(32), P2 = "pass-2";
  const T3 = "C".repeat(32), P3 = "pass-3";
  const T4 = "D".repeat(32), P4 = "pass-4";
  await seedPass(T2, P2);
  await seedPass(T3, P3);
  await seedPass(T4, P4);

  await assertFails(
    as(OTHER).doc(`gp_gates/${CODE}/claims/${P2}`).set({ ...claim(), token: T2, scannedAt: backdated }));
  await assertSucceeds(
    as(OWNER).doc(`gp_gates/${CODE}/claims/${P3}`).set({ ...claim(), token: T3, scannedAt: backdated }));
  await assertFails(
    as("third-uid").doc(`gp_gates/${CODE}/claims/${P4}`).set({ ...claim(), token: T4, scannedAt: backdated }));
});

test("14. owner can update an existing claim under their gate; staff cannot", async () => {
  await seedClaim();
  await assertSucceeds(as(OWNER).doc(`gp_gates/${CODE}/claims/${PASS}`).update({ gate: "Gate 2" }));
  await assertFails(as(OTHER).doc(`gp_gates/${CODE}/claims/${PASS}`).update({ gate: "Gate 3" }));
});

test("15. owner can pre-create a gate doc for an existing event (rotation pre-create); others cannot", async () => {
  const gate = { eventId: EVENT, total: 0, checked: 0, bounced: 0, recent: [] };
  await assertSucceeds(as(OWNER).doc(`gp_gates/NEWCODE2`).set(gate));
  await assertFails(as(OTHER).doc(`gp_gates/NEWCODE2b`).set(gate));
  await assertFails(as(null).doc(`gp_gates/NEWCODE2c`).set(gate));
});

test("16. staff get on an existing gate code succeeds; get on a deleted/unknown code fails", async () => {
  await assertSucceeds(as(OTHER).doc(`gp_gates/${CODE}`).get());
  await assertFails(as(OTHER).doc(`gp_gates/NO_SUCH_CODE`).get());
});

// ---- Repeats rules (17-22) ----

test("17. staff may create a repeat with a server timestamp and exactly the allowed keys", async () => {
  await seedClaim();
  await assertSucceeds(as(null).doc(REPEAT).set(repeat()));
});

test("18. staff repeat create with a backdated scannedAt is denied", async () => {
  await seedClaim();
  await assertFails(as(null).doc(REPEAT).set({ ...repeat(), scannedAt: new Date("2020-01-01") }));
});

test("19. owner repeat create with a backdated scannedAt is allowed", async () => {
  await seedClaim();
  await assertSucceeds(as(OWNER).doc(REPEAT).set({ ...repeat(), scannedAt: new Date("2020-01-01") }));
});

test("20. repeat create with an extra field is denied", async () => {
  await seedClaim();
  await assertFails(as(null).doc(REPEAT).set({ ...repeat(), extra: "nope" }));
});

test("21. staff cannot update or delete an existing repeat", async () => {
  await seedClaim();
  await seedRepeat();
  await assertFails(as(null).doc(REPEAT).update({ gate: "Gate 2" }));
  await assertFails(as(null).doc(REPEAT).delete());
});

test("22. owner can update and delete an existing repeat", async () => {
  await seedClaim();
  await seedRepeat();
  await assertSucceeds(as(OWNER).doc(REPEAT).update({ gate: "Gate 2" }));
  await assertSucceeds(as(OWNER).doc(REPEAT).delete());
});

// ---- Claim binding negatives (23-24) ----

test("23. claim create denied when the token's pass id does not match the claim passId", async () => {
  const badToken = "E".repeat(32);
  await seedPass(badToken, "pass-wrong");
  await assertFails(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).set({ ...claim(), token: badToken }));
});

test("24. claim create denied when the pass belongs to a different event than the gate", async () => {
  const badToken = "F".repeat(32);
  await seedPass(badToken, PASS, "event-2");
  await assertFails(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).set({ ...claim(), token: badToken, eventId: EVENT }));
});

// ---- Positive staff stamp writes (25-26) — REMOVED 21 Nov 2026 ----
// The old rules let unauthenticated staff write only the stamp fields on a
// pass / roster entry. That was the fake-check-in hole: any token-holder
// could flip checkedInAt/gate without a scan. Both are owner-only now, and
// the scan transaction no longer writes those stamps (the claim is the
// authority). These tests now assert the direct writes are DENIED.

test("25. unauthenticated user cannot set checkedInAt on a pass; owner can", async () => {
  await assertFails(as(null).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: new Date(), gate: "Gate 1" }));
  await assertFails(as(OTHER).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: new Date(), gate: "Gate 1" }));
  await assertSucceeds(as(OWNER).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: new Date(), gate: "Gate 1" }));
});

test("26. unauthenticated user cannot mark a roster entry checked-in by direct write", async () => {
  await assertFails(as(null).doc(`gp_gates/${CODE}/roster/${PASS}`).update({ checkedInAt: new Date(), gate: "Gate 1" }));
  await assertFails(as(OTHER).doc(`gp_gates/${CODE}/roster/${PASS}`).update({ checkedInAt: new Date(), gate: "Gate 1" }));
  await assertSucceeds(as(OWNER).doc(`gp_gates/${CODE}/roster/${PASS}`).update({ checkedInAt: new Date(), gate: "Gate 1" }));
});

// ---- Security fixes, 21 Nov 2026 (27-29) ----

test("27. token-holder cannot fake a check-in even after a real claim exists", async () => {
  await seedClaim();
  // The claim exists now, but the pass stamp is still owner-only.
  await assertFails(as(null).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: new Date(), gate: "Gate 2" }));
  await assertFails(as(null).doc(`gp_passes/${TOKEN}`).update({ gate: "Gate 2" }));
});

test("28. gate staff cannot mark a pass checked-in on the roster, with or without a claim", async () => {
  await assertFails(as(null).doc(`gp_gates/${CODE}/roster/${PASS}`).update({ checkedInAt: new Date(), gate: "Gate 1" }));
  await seedClaim();
  await assertFails(as(null).doc(`gp_gates/${CODE}/roster/${PASS}`).update({ checkedInAt: new Date(), gate: "Gate 1" }));
  await assertFails(as(null).doc(`gp_gates/${CODE}/roster/${PASS}`).update({ gate: "Gate 1" }));
});

test("29. first scan + repeat scan still work as transactions (claim + gate counters only)", async () => {
  const db = as(null);
  // First scan: create the one-shot claim, bump the gate counter.
  await assertSucceeds(runTransaction(db, async (tx) => {
    const existing = await tx.get(db.doc(`gp_gates/${CODE}/claims/${PASS}`));
    assert.equal(existing.exists(), false);
    tx.set(db.doc(`gp_gates/${CODE}/claims/${PASS}`), claim());
    tx.update(db.doc(`gp_gates/${CODE}`), { checked: 1, recent: [] });
  }));
  // Repeat scan: claim already exists, so write a repeat + bump bounced.
  await assertSucceeds(runTransaction(db, async (tx) => {
    const existing = await tx.get(db.doc(`gp_gates/${CODE}/claims/${PASS}`));
    assert.equal(existing.exists(), true);
    tx.set(db.doc(REPEAT), repeat());
    tx.update(db.doc(`gp_gates/${CODE}`), { bounced: 1, recent: [] });
  }));
  // And the claim itself still cannot be overwritten (second first-scan).
  await assertFails(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).set(claim()));
});

// ---- Phase A: fests, sub-events, public registration (30-38) ----

const FEST = "fest-1", SUBEVENT = "subevent-1", STUDENT = "student-uid";
const FEST_CODE = "FEST2345";   // 8 characters, the same shape as a legacy gate code
const WRONG_CODE = "WRONG234";  // a real gate doc, but NOT the descriptor's code

// Fest + open sub-event + its gate + the signed-in-readable descriptor. Seeded
// with rules disabled so each test starts from one consistent Phase A graph.
const seedPhaseA = (overrides = {}) => env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const startsAt = new Date();
  const { registrationOpen = true, descriptorCode = FEST_CODE, subEventCode = FEST_CODE } = overrides;
  await db.doc(`gp_fests/${FEST}`).set({
    ownerId: OWNER, name: "Spring Fest", club: "Test Club", venue: "Main Hall", art: 0,
    startsAt, sheetId: "", sheetRange: "Registrations", createdAt: startsAt,
  });
  await db.doc(`gp_users/${OWNER}/fests/${FEST}`).set({ name: "Spring Fest", startsAt });
  await db.doc(`gp_fests/${FEST}/events/${SUBEVENT}`).set({
    festId: FEST, name: "Tech Talk", club: "Test Club", venue: "Main Hall", art: 0,
    startsAt, gateCode: subEventCode, registrationOpen,
    capacity: 0, total: 0, checked: 0, bounced: 0, recent: [], createdAt: startsAt,
  });
  await db.doc(`gp_gates/${FEST_CODE}`).set({
    festId: FEST, eventId: SUBEVENT, name: "Tech Talk", club: "Test Club",
    venue: "Main Hall", art: 0, startsAt,
    total: 0, checked: 0, bounced: 0, recent: [],
  });
  await db.doc(`gp_reg_public/${SUBEVENT}`).set({
    festId: FEST, name: "Tech Talk", club: "Test Club", venue: "Main Hall", art: 0,
    startsAt, gateCode: descriptorCode, registrationOpen, capacity: 0, total: 0,
  });
});

// The four writes registerStudentWithCode() performs, minus the roster/public
// pass writes which have their own tests below.
const registrationBatch = (db, { uid = STUDENT, passId = "reg-pass-1", token = "R".repeat(32), regId = "reg-1" } = {}) => {
  const batch = writeBatch(db);
  batch.set(db.doc(`gp_fests/${FEST}/events/${SUBEVENT}/passes/${passId}`), {
    name: "Grace Hopper", contact: "grace@example.com", token, uid,
    registrationId: regId, createdAt: serverTimestamp(), checkedInAt: null, gate: "",
  });
  batch.set(db.doc(`gp_fests/${FEST}/registrations/${regId}`), {
    eventId: SUBEVENT, eventName: "Tech Talk", festId: FEST,
    name: "Grace Hopper", email: "grace@example.com", phone: "", uid,
    passId, token, createdAt: serverTimestamp(), sheetSynced: false,
  });
  return batch;
};

test("30. registration descriptor: signed-in get, anonymous denied, list denied", async () => {
  await seedPhaseA();
  await assertSucceeds(as(STUDENT).doc(`gp_reg_public/${SUBEVENT}`).get());
  await assertSucceeds(as(OWNER).doc(`gp_reg_public/${SUBEVENT}`).get());
  await assertFails(as(null).doc(`gp_reg_public/${SUBEVENT}`).get());
  await assertFails(as(STUDENT).collection("gp_reg_public").get());
  await assertFails(as(OWNER).collection("gp_reg_public").get());
});

test("31. student can create their own pass and registration on an open event", async () => {
  await seedPhaseA();
  await assertSucceeds(registrationBatch(as(STUDENT)).commit());
});

test("32. a student cannot register with somebody else's uid", async () => {
  await seedPhaseA();
  await assertFails(registrationBatch(as(STUDENT), { uid: OTHER }).commit());
});

test("33. registrations are readable only by the fest owner", async () => {
  await seedPhaseA();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`gp_fests/${FEST}/registrations/reg-1`).set({
      festId: FEST, eventId: SUBEVENT, uid: STUDENT, name: "Grace Hopper",
      email: "grace@example.com", phone: "", passId: "reg-pass-1",
      token: "R".repeat(32), createdAt: new Date(), sheetSynced: false,
    });
  });
  await assertSucceeds(as(OWNER).doc(`gp_fests/${FEST}/registrations/reg-1`).get());
  await assertSucceeds(as(OWNER).collection(`gp_fests/${FEST}/registrations`).get());
  await assertFails(as(STUDENT).doc(`gp_fests/${FEST}/registrations/reg-1`).get());
  await assertFails(as(OTHER).doc(`gp_fests/${FEST}/registrations/reg-1`).get());
  await assertFails(as(null).doc(`gp_fests/${FEST}/registrations/reg-1`).get());
  await assertFails(as(STUDENT).collection(`gp_fests/${FEST}/registrations`).get());
});

test("34. registration on a closed event is denied", async () => {
  await seedPhaseA({ registrationOpen: false });
  await assertFails(registrationBatch(as(STUDENT)).commit());
});

test("35. the public pass doc never carries the gate code", async () => {
  await seedPhaseA();
  const token = "P".repeat(32);
  const pass = {
    id: "pub-pass-1", festId: FEST, eventId: SUBEVENT,
    event: { name: "Tech Talk", club: "Test Club", starts_at: "2026-11-22T10:00:00.000Z", venue: "Main Hall", art: 0 },
    name: "Grace Hopper", checkedInAt: null, gate: "",
  };
  // The student create grant uses hasOnly(), so a gateCode field is refused.
  await assertFails(as(STUDENT).doc(`gp_passes/${token}`).set({ ...pass, gateCode: FEST_CODE }));
  await assertSucceeds(as(STUDENT).doc(`gp_passes/${token}`).set(pass));
  const pub = await as(null).doc(`gp_passes/${token}`).get();
  assert.equal(pub.data().gateCode, undefined);
  assert.equal(pub.data().event.gateCode, undefined);
});

test("36. roster create by a student: matching descriptor code allowed, wrong code denied", async () => {
  await seedPhaseA();
  // A second, real gate doc for the same sub-event — but the descriptor says FEST_CODE.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`gp_gates/${WRONG_CODE}`).set({
      festId: FEST, eventId: SUBEVENT, name: "Tech Talk",
      total: 0, checked: 0, bounced: 0, recent: [],
    });
  });
  const rosterRow = { name: "Grace Hopper", nameLower: "grace hopper", hint: "gr•••@example.com",
    token: "R".repeat(32), checkedInAt: null, gate: "" };
  await assertSucceeds(as(STUDENT).doc(`gp_gates/${FEST_CODE}/roster/roster-1`).set(rosterRow));
  await assertFails(as(STUDENT).doc(`gp_gates/${WRONG_CODE}/roster/roster-2`).set(rosterRow));
  // Anonymous gate staff still cannot write a roster entry.
  await assertFails(as(null).doc(`gp_gates/${FEST_CODE}/roster/roster-3`).set(rosterRow));
});

test("37. fest sub-event gate create: owner allowed, non-owner denied", async () => {
  await seedPhaseA();
  const NEW_CODE = "FEST5678", OTHER_CODE = "FEST9999";
  await env.withSecurityRulesDisabled(async (ctx) => {
    // Two sub-events, each expecting a different (not yet existing) gate code.
    for (const [id, code] of [["subevent-2", NEW_CODE], ["subevent-3", OTHER_CODE]]) {
      await ctx.firestore().doc(`gp_fests/${FEST}/events/${id}`).set({
        festId: FEST, name: "Quiz Night", gateCode: code, registrationOpen: true,
        total: 0, checked: 0, bounced: 0, recent: [],
      });
    }
  });
  const gate = (id) => ({ festId: FEST, eventId: id, name: "Quiz Night",
    total: 0, checked: 0, bounced: 0, recent: [] });
  // Fresh codes, so these are genuine create operations.
  await assertSucceeds(as(OWNER).doc(`gp_gates/${NEW_CODE}`).set(gate("subevent-2")));
  await assertFails(as(OTHER).doc(`gp_gates/${OTHER_CODE}`).set(gate("subevent-3")));
  await assertFails(as(null).doc(`gp_gates/${OTHER_CODE}`).set(gate("subevent-3")));
  // A non-owner cannot edit an existing fest gate's metadata either (a no-op
  // write with unchanged fields is allowed for counter updates, but not this).
  await assertFails(as(OTHER).doc(`gp_gates/${NEW_CODE}`).update({ name: "Hacked" }));
});

test("38. the fest owner can read a sub-event; another user cannot", async () => {
  await seedPhaseA();
  await assertSucceeds(as(OWNER).doc(`gp_fests/${FEST}/events/${SUBEVENT}`).get());
  await assertSucceeds(as(OWNER).doc(`gp_fests/${FEST}`).get());
  await assertFails(as(STUDENT).doc(`gp_fests/${FEST}/events/${SUBEVENT}`).get());
  await assertFails(as(OTHER).doc(`gp_fests/${FEST}`).get());
  await assertFails(as(null).collection("gp_fests").get());
});

// ---- Luma-style events v2 + RSVPs (39-45) ----
// The v2 event doc is the only authority for visibility/ownership. RSVP docs
// live under gp_rsvps/{eventId}/rsvps/{uid}, where the doc id is the attendee's
// uid; rules let each attendee create/delete only their own RSVP, and never
// update one. These tests seed with rules disabled (emulator admin) so each
// case starts from one consistent public + private event graph.
const V2_PUBLIC = "v2-public", V2_PRIVATE = "v2-private";
const V2_NEW = "v2-new", V2_NEW_OTHER = "v2-new-other", V2_FIELDS = "v2-fields";
const RSVPER = "rsvper-uid", FRESH_RSVP = "fresh-rsvp-uid";

const seedV2 = () => env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + 3600000);
  const row = (title, visibility) => ({
    ownerId: OWNER, title, visibility, cover: "crowd", startsAt, endsAt,
    timezone: "GMT+05:30 · Kolkata", location: "Test Hall", description: "A test event",
    price: "Free", approval: false, capacity: 0,
  });
  await db.doc(`gp_events_v2/${V2_PUBLIC}`).set(row("Public V2 Event", "public"));
  await db.doc(`gp_events_v2/${V2_PRIVATE}`).set(row("Private V2 Event", "private"));
  // Owner-scoped index used by the client for private/owner lists.
  await db.doc(`gp_users/${OWNER}/createdEvents/${V2_PUBLIC}`).set({ title: "Public V2 Event", startsAt, visibility: "public" });
  await db.doc(`gp_users/${OWNER}/createdEvents/${V2_PRIVATE}`).set({ title: "Private V2 Event", startsAt, visibility: "private" });
  // Seeded RSVPs (one per event) give read/update/delete tests a live doc.
  for (const eventId of [V2_PUBLIC, V2_PRIVATE]) {
    for (const uid of [OTHER, RSVPER]) {
      await db.doc(`gp_rsvps/${eventId}/rsvps/${uid}`).set({ uid, name: "Ada", email: "ada@x.com", at: startsAt });
    }
  }
});
const v2row = (ownerId) => ({
  ownerId, title: "Another V2 Event", visibility: "public", cover: "crowd",
  startsAt: new Date(), endsAt: new Date(Date.now() + 3600000), location: "Hall",
});

test("39. public v2 event: get is open to all; list needs the visibility filter; owner uses the index", async () => {
  await seedV2();
  await assertSucceeds(as(null).doc(`gp_events_v2/${V2_PUBLIC}`).get());
  await assertSucceeds(as(OTHER).doc(`gp_events_v2/${V2_PUBLIC}`).get());
  await assertSucceeds(as(OWNER).doc(`gp_events_v2/${V2_PUBLIC}`).get());
  // Rules are not filters: a bare collection read hits the private doc and fails;
  // the client's where("visibility","==","public") query succeeds.
  await assertFails(as(null).collection("gp_events_v2").get());
  const pub = await assertSucceeds(as(null).collection("gp_events_v2").where("visibility", "==", "public").get());
  assert.equal(pub.size, 1);
  assert.equal(pub.docs[0].id, V2_PUBLIC);
  // Owner listing uses the owner-scoped index, not a query on gp_events_v2.
  await assertSucceeds(as(OWNER).collection(`gp_users/${OWNER}/createdEvents`).get());
  await assertFails(as(OTHER).collection(`gp_users/${OWNER}/createdEvents`).get());
});

test("40. private v2 event: signed-in link visitor gets it and its RSVPs; anonymous cannot; lists stay public-only", async () => {
  await seedV2();
  // The long event URL is the capability: any signed-in link-holder may GET a
  // private event, even though they never see it in a feed. Anonymous cannot.
  await assertFails(as(null).doc(`gp_events_v2/${V2_PRIVATE}`).get());
  await assertSucceeds(as(OTHER).doc(`gp_events_v2/${V2_PRIVATE}`).get());
  await assertSucceeds(as(OWNER).doc(`gp_events_v2/${V2_PRIVATE}`).get());
  // List queries still exclude private events for everyone (rules are NOT
  // filters: the client always carries the visibility filter).
  const anonList = await assertSucceeds(
    as(null).collection("gp_events_v2").where("visibility", "==", "public").get());
  assert.equal(anonList.size, 1);
  assert.equal(anonList.docs[0].id, V2_PUBLIC);
  const linkList = await assertSucceeds(
    as(OTHER).collection("gp_events_v2").where("visibility", "==", "public").get());
  assert.equal(linkList.size, 1);
  assert.equal(linkList.docs[0].id, V2_PUBLIC);
  await assertFails(as(OTHER).collection("gp_events_v2").get()); // bare list hits the private doc
  // RSVP reads: a signed-in link visitor can read the private event's RSVPs
  // (needed for their own status and the member list); anonymous cannot.
  const rsvp = `gp_rsvps/${V2_PRIVATE}/rsvps/${RSVPER}`;
  await assertSucceeds(as(OTHER).doc(rsvp).get());
  await assertSucceeds(as(OTHER).collection(`gp_rsvps/${V2_PRIVATE}/rsvps`).get());
  await assertFails(as(null).doc(rsvp).get());
  await assertFails(as(null).collection(`gp_rsvps/${V2_PRIVATE}/rsvps`).get());
  await assertSucceeds(as(OWNER).doc(rsvp).get());
  await assertSucceeds(as(OWNER).collection(`gp_rsvps/${V2_PRIVATE}/rsvps`).get());
  // Public events remain readable by anonymous visitors as before.
  await assertSucceeds(as(null).collection(`gp_rsvps/${V2_PUBLIC}/rsvps`).get());
});

test("41. v2 event create needs a matching ownerId; update/delete are owner-only", async () => {
  await seedV2();
  await assertSucceeds(as(OWNER).doc(`gp_events_v2/${V2_NEW}`).set(v2row(OWNER)));
  await assertSucceeds(as(OTHER).doc(`gp_events_v2/${V2_NEW_OTHER}`).set(v2row(OTHER)));
  await assertFails(as(OTHER).doc(`gp_events_v2/v2-forged`).set(v2row(OWNER)));
  await assertFails(as(null).doc(`gp_events_v2/v2-anon`).set(v2row(OWNER)));
  await assertSucceeds(as(OWNER).doc(`gp_events_v2/${V2_PUBLIC}`).update({ title: "Renamed by owner" }));
  await assertFails(as(OTHER).doc(`gp_events_v2/${V2_PUBLIC}`).update({ title: "Hacked" }));
  await assertFails(as(null).doc(`gp_events_v2/${V2_PUBLIC}`).update({ title: "Hacked" }));
  await assertFails(as(OTHER).doc(`gp_events_v2/${V2_PUBLIC}`).delete());
  await assertFails(as(null).doc(`gp_events_v2/${V2_PUBLIC}`).delete());
  await assertSucceeds(as(OWNER).doc(`gp_events_v2/${V2_PUBLIC}`).delete());
});

test("42. an attendee can create only their own RSVP", async () => {
  await seedV2();
  // FRESH_RSVP has no seeded doc, so these are genuine creates.
  await assertSucceeds(as(FRESH_RSVP).doc(`gp_rsvps/${V2_PUBLIC}/rsvps/${FRESH_RSVP}`).set({
    uid: FRESH_RSVP, name: "Lin", email: "lin@x.com", at: new Date(),
  }));
  await assertFails(as(RSVPER).doc(`gp_rsvps/${V2_PUBLIC}/rsvps/${FRESH_RSVP}`).set({
    uid: FRESH_RSVP, name: "Impostor", email: "x@x.com", at: new Date(),
  }));
  await assertFails(as(null).doc(`gp_rsvps/${V2_PUBLIC}/rsvps/anon`).set({
    uid: "anon", name: "Anon", email: "a@x.com", at: new Date(),
  }));
});

test("43. RSVP update: owner edits any member, member edits own, others and anon denied", async () => {
  await seedV2();
  const rsvp = (uid) => `gp_rsvps/${V2_PUBLIC}/rsvps/${uid}`;
  // A signed-in non-owner cannot edit somebody else's RSVP; anon cannot edit at all.
  await assertFails(as(OTHER).doc(rsvp(RSVPER)).update({ name: "Hacked" }));
  await assertFails(as(RSVPER).doc(rsvp(OTHER)).update({ name: "Hacked" }));
  await assertFails(as(null).doc(rsvp(OTHER)).update({ name: "Hacked" }));
  // The event owner can update any member's details from the member directory.
  await assertSucceeds(as(OWNER).doc(rsvp(OTHER)).update({ name: "Renamed by owner", phone: "9876543210" }));
  await assertSucceeds(as(OWNER).doc(rsvp(RSVPER)).update({ college: "Edited by owner" }));
  // A member can update their own details ("Edit my details").
  await assertSucceeds(as(RSVPER).doc(rsvp(RSVPER)).update({ name: "Renamed by member" }));
  await assertSucceeds(as(OTHER).doc(rsvp(OTHER)).update({ name: "Renamed by member" }));
});

test("44. RSVP delete: owner removes any member, member cancels own, others and anon denied", async () => {
  await seedV2();
  const rsvp = (uid) => `gp_rsvps/${V2_PUBLIC}/rsvps/${uid}`;
  // A signed-in non-owner cannot delete somebody else's RSVP; anon cannot delete at all.
  await assertFails(as(OTHER).doc(rsvp(RSVPER)).delete());
  await assertFails(as(RSVPER).doc(rsvp(OTHER)).delete());
  await assertFails(as(null).doc(rsvp(OTHER)).delete());
  // The event owner can delete any member's RSVP from the member directory.
  await assertSucceeds(as(OWNER).doc(rsvp(OTHER)).delete());
  await assertSucceeds(as(OWNER).doc(rsvp(RSVPER)).delete());
  // A member can still cancel their own RSVP. Re-seed so both docs exist again.
  await seedV2();
  await assertSucceeds(as(RSVPER).doc(rsvp(RSVPER)).delete());
  await assertSucceeds(as(OTHER).doc(rsvp(OTHER)).delete());
});

test("45. an owner-scoped index write is allowed only under the caller's own uid", async () => {
  await seedV2();
  await assertSucceeds(as(OWNER).doc(`gp_users/${OWNER}/createdEvents/v2-index-new`).set({
    title: "Indexed", startsAt: new Date(), visibility: "private",
  }));
  await assertFails(as(OTHER).doc(`gp_users/${OWNER}/createdEvents/v2-index-forged`).set({
    title: "Forged", startsAt: new Date(), visibility: "private",
  }));
  await assertFails(as(null).doc(`gp_users/${OWNER}/createdEvents/v2-index-anon`).set({
    title: "Anon", startsAt: new Date(), visibility: "private",
  }));
});

test("46. configurable fields: event carries formFields and member answers are stored and editable", async () => {
  await seedV2();
  const formFields = [
    { key: "name", label: "Full name", type: "text", required: true, enabled: true },
    { key: "email", label: "Email", type: "email", required: true, enabled: true },
    { key: "phone", label: "Phone number", type: "tel", required: false, enabled: true },
    { key: "college", label: "College", type: "text", required: false, enabled: true },
    { key: "year", label: "Year of study", type: "text", required: false, enabled: true },
  ];
  // The owner stores the configured field list on the event.
  await assertSucceeds(as(OWNER).doc(`gp_events_v2/${V2_FIELDS}`).set({
    ...v2row(OWNER), title: "Fields Event", formFields,
  }));
  const event = await as(null).doc(`gp_events_v2/${V2_FIELDS}`).get();
  assert.deepEqual(event.data().formFields, formFields);

  // A member creates only their own RSVP, carrying answers for the configured fields.
  const answers = { name: "Lin", email: "lin@x.com", phone: "9876543210", college: "Test College", year: "3rd" };
  const path = `gp_rsvps/${V2_FIELDS}/rsvps/${FRESH_RSVP}`;
  await assertSucceeds(as(FRESH_RSVP).doc(path).set({ uid: FRESH_RSVP, ...answers, answers, at: new Date() }));
  await assertFails(as(OTHER).doc(path).set({ uid: FRESH_RSVP, ...answers, answers, at: new Date() }));
  const stored = await as(OWNER).doc(path).get();
  assert.equal(stored.data().answers.year, "3rd");
  assert.equal(stored.data().college, "Test College");
  assert.equal(stored.data().phone, "9876543210");

  // Owner edits the member's answers from the directory; the member edits their own.
  await assertSucceeds(as(OWNER).doc(path).update({
    answers: { ...answers, phone: "1112223333" }, phone: "1112223333",
  }));
  const edited = await as(OWNER).doc(path).get();
  assert.equal(edited.data().answers.phone, "1112223333");
  await assertSucceeds(as(FRESH_RSVP).doc(path).update({
    answers: { ...answers, college: "Another College" }, college: "Another College",
  }));
  // Create remains own-only even for an event with custom fields.
  await assertFails(as(null).doc(`gp_rsvps/${V2_FIELDS}/rsvps/anon`).set({
    uid: "anon", ...answers, answers, at: new Date(),
  }));
});

// ---- Sharing / approval / QR pass issuing (47-50) ----

const V2_APPROVAL = "v2-approval";
const APPROVAL_CODE = "APPR2345";
const PASS_TOKEN = "T".repeat(32);

// Approval-on, link-only event with its gate and two pending/rejected RSVPs.
const seedV2Approval = () => env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const at = new Date();
  await db.doc(`gp_events_v2/${V2_APPROVAL}`).set({
    ownerId: OWNER, title: "Approval V2 Event", visibility: "private",
    approval: true, gateCode: APPROVAL_CODE, cover: "crowd",
    startsAt: at, endsAt: new Date(at.getTime() + 3600000), location: "Hall",
    price: "Free", capacity: 0,
  });
  await db.doc(`gp_gates/${APPROVAL_CODE}`).set({
    eventId: V2_APPROVAL, name: "Approval V2 Event", total: 0,
    checked: 0, bounced: 0, recent: [],
  });
  await db.doc(`gp_rsvps/${V2_APPROVAL}/rsvps/${OTHER}`).set({
    uid: OTHER, name: "Ada", email: "ada@x.com",
    answers: { name: "Ada", email: "ada@x.com" }, status: "pending", at,
  });
  await db.doc(`gp_rsvps/${V2_APPROVAL}/rsvps/${RSVPER}`).set({
    uid: RSVPER, name: "Lin", email: "lin@x.com", status: "rejected", at,
  });
});

test("47. approval writes: the owner approves/rejects any member, other users cannot", async () => {
  await seedV2Approval();
  const rsvp = (uid) => `gp_rsvps/${V2_APPROVAL}/rsvps/${uid}`;
  const reviewed = { reviewedAt: new Date(), reviewedBy: OWNER };
  // approveMember()'s status + passToken write, and rejectMember()'s write.
  await assertSucceeds(as(OWNER).doc(rsvp(OTHER)).update({
    status: "approved", passToken: PASS_TOKEN, ...reviewed,
  }));
  await assertSucceeds(as(OWNER).doc(rsvp(OTHER)).update({ status: "rejected", ...reviewed }));
  // A different signed-in member, and an anonymous caller, cannot review anyone.
  await assertFails(as(OTHER).doc(rsvp(RSVPER)).update({ status: "approved", passToken: PASS_TOKEN }));
  await assertFails(as(null).doc(rsvp(RSVPER)).update({ status: "rejected" }));
});

test("48. a member cannot self-approve on an approval event, but may edit details / resubmit to pending", async () => {
  await seedV2Approval();
  const own = `gp_rsvps/${V2_APPROVAL}/rsvps/${OTHER}`;
  // The approval state and pass token are host-only capabilities.
  await assertFails(as(OTHER).doc(own).update({ status: "approved" }));
  await assertFails(as(OTHER).doc(own).update({ status: "approved", passToken: PASS_TOKEN }));
  await assertFails(as(OTHER).doc(own).update({ passToken: PASS_TOKEN }));
  await assertFails(as(OTHER).doc(`gp_rsvps/${V2_APPROVAL}/rsvps/fresh-self-approve`).set({
    uid: "fresh-self-approve", name: "Lin", status: "approved", passToken: PASS_TOKEN,
  }));
  // Normal detail edits still work, and a rejected member may resubmit a
  // fresh pending request (rsvpEvent()'s set() is an update of the same doc).
  await assertSucceeds(as(OTHER).doc(own).update({
    name: "Ada Lovelace", answers: { name: "Ada Lovelace", email: "ada@x.com" },
  }));
  const rejected = `gp_rsvps/${V2_APPROVAL}/rsvps/${RSVPER}`;
  await assertSucceeds(as(RSVPER).doc(rejected).set({
    uid: RSVPER, name: "Lin", status: "pending",
    answers: { name: "Lin" }, at: new Date(),
  }));
  // Even after resubmitting, approval is still the host's call.
  await assertFails(as(RSVPER).doc(rejected).update({ status: "approved", passToken: PASS_TOKEN }));
});

test("49. v2 owner issues a pass + roster row + gate total atomically; members cannot on approval events", async () => {
  await seedV2Approval();
  const db = as(OWNER);
  const pass = {
    id: OTHER, eventId: V2_APPROVAL, event: { name: "Approval V2 Event" },
    name: "Ada", checkedInAt: null, gate: "",
  };
  const batch = writeBatch(db);
  batch.set(db.doc(`gp_passes/${PASS_TOKEN}`), pass);
  batch.set(db.doc(`gp_gates/${APPROVAL_CODE}/roster/${OTHER}`), {
    name: "Ada", nameLower: "ada", hint: "ad•••@x.com", token: PASS_TOKEN,
    checkedInAt: null, gate: "",
  });
  batch.update(db.doc(`gp_gates/${APPROVAL_CODE}`), { total: 1 });
  await assertSucceeds(batch.commit());
  const issued = await as(null).doc(`gp_passes/${PASS_TOKEN}`).get();
  assert.equal(issued.data().eventId, V2_APPROVAL);
  assert.equal(issued.data().gateCode, undefined);
  assert.equal(issued.data().event.gateCode, undefined);

  // The same writes by a member are refused for an approval event: no
  // self-issued roster row and no self-incremented gate total.
  const member = as(OTHER);
  const bad = writeBatch(member);
  bad.set(member.doc(`gp_gates/${APPROVAL_CODE}/roster/${RSVPER}`), {
    name: "Lin", nameLower: "lin", hint: "li•••@x.com", token: PASS_TOKEN,
  });
  bad.update(member.doc(`gp_gates/${APPROVAL_CODE}`), { total: 2 });
  await assertFails(bad.commit());
  // And an owner cannot smuggle the gate code into a public pass document.
  await assertFails(as(OWNER).doc(`gp_passes/${"U".repeat(32)}`).set({
    ...pass, gateCode: APPROVAL_CODE,
  }));
});

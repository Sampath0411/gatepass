import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { serverTimestamp } from "firebase/firestore";

const PROJECT = "gatepass-test", OWNER = "owner-uid", OTHER = "other-uid";
const EVENT = "event-1", CODE = "ABCD2345", TOKEN = "A".repeat(32), PASS = "pass-1";
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

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
  });
  await seed();
});
after(async () => { await env.clearFirestore(); await env.cleanup(); });

const as = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const claim = () => ({
  eventId: EVENT, token: TOKEN, name: "Ada", gate: "Gate 1", device: "dev",
  scannedAt: serverTimestamp(),
});

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
  await assertSucceeds(as(OTHER).doc(`gp_gates/${CODE}/claims/${PASS}`).set(claim()));
});

test("6. second claim create for the same pass is denied", async () => {
  await assertFails(as(OTHER).doc(`gp_gates/${CODE}/claims/${PASS}`).set(claim()));
});

test("7. claim create under an unknown code is denied", async () => {
  await assertFails(as(OTHER).doc(`gp_gates/UNKNOWNCODE/claims/${PASS}`).set(claim()));
});

test("8. claim cannot be updated or deleted by staff", async () => {
  await assertFails(as(OTHER).doc(`gp_gates/${CODE}/claims/${PASS}`).update({ gate: "Hacked" }));
  await assertFails(as(OTHER).doc(`gp_gates/${CODE}/claims/${PASS}`).delete());
});

test("9. gate staff may update only counters/recent on gp_gates (checked succeeds, name fails; also total fails)", async () => {
  await assertSucceeds(as(OTHER).doc(`gp_gates/${CODE}`).update({ checked: 1 }));
  await assertFails(as(OTHER).doc(`gp_gates/${CODE}`).update({ name: "X" }));
  await assertFails(as(OTHER).doc(`gp_gates/${CODE}`).update({ total: 2 }));
});

test("10. gate staff cannot change the gate doc's eventId", async () => {
  await assertFails(as(OTHER).doc(`gp_gates/${CODE}`).update({ eventId: "other-event" }));
});

test("11. roster is readable by code but not writable by staff", async () => {
  await assertSucceeds(as(OTHER).doc(`gp_gates/${CODE}/roster/${PASS}`).get());
  await assertFails(as(OTHER).doc(`gp_gates/${CODE}/roster/${PASS}`).update({ name: "X" }));
});

test("12. old code stops working after rotation (get nonexistent code fails)", async () => {
  await assertFails(as(OTHER).doc(`gp_gates/OLDODECODE`).get());
});

// ---- Additional tests for the tightened/extended rules (13-16) ----

const seedPass = (token, passId) => env.withSecurityRulesDisabled(async (ctx) => {
  await ctx.firestore().doc(`gp_passes/${token}`).set({
    id: passId, eventId: EVENT, name: "Ada", checkedInAt: null, gate: "",
  });
});

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

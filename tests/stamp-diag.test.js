import { test, before, after, beforeEach, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";

const PROJECT = "gatepass-test", OWNER = "owner-uid", OTHER = "other-uid";
const EV2 = "event-v2", CODE = "X8CDE2UH", TOKEN = "B".repeat(32), PASS = "pass-v2";
let env;

const seed = () => env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await db.doc(`gp_events_v2/${EV2}`).set({ ownerId: OWNER, gateCode: CODE, title: "T", visibility: "public" });
  await db.doc(`gp_gates/${CODE}`).set({ eventId: EV2, total: 1, checked: 1, bounced: 0, recent: [] });
  await db.doc(`gp_passes/${TOKEN}`).set({ id: PASS, eventId: EV2, name: "Test One", checkedInAt: null, gate: "" });
  await db.doc(`gp_gates/${CODE}/claims/${PASS}`).set({
    eventId: EV2, token: TOKEN, name: "Test One", gate: "Gate 1", device: "dev", scannedAt: new Date(),
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

test("D1. v2 owner stamp update (single updateDoc) succeeds", async () => {
  await assertSucceeds(as(OWNER).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: new Date(), gate: "Gate 1" }));
});

test("D2. v2 owner stamp update via WriteBatch succeeds", async () => {
  const db = as(OWNER);
  const batch = db.batch();
  batch.update(db.doc(`gp_passes/${TOKEN}`), { checkedInAt: new Date(), gate: "Gate 1" });
  await assertSucceeds(batch.commit());
});

test("D3. non-owner stamp update fails", async () => {
  await assertFails(as(OTHER).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: new Date(), gate: "Gate 1" }));
});

test("D4. owner stamp update touching name fails (scope)", async () => {
  await assertFails(as(OWNER).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: new Date(), gate: "Gate 1", name: "X" }));
});

test("D5. unauthenticated reads: pass doc + claim doc succeed", async () => {
  await assertSucceeds(as(null).doc(`gp_passes/${TOKEN}`).get());
  await assertSucceeds(as(null).doc(`gp_gates/${CODE}/claims/${PASS}`).get());
});

test("D6. owner lists claims collection", async () => {
  await assertSucceeds(as(OWNER).collection(`gp_gates/${CODE}/claims`).get());
});

// ── Claim-bound stamp projection grant (28 Nov 2026) ──
// The gate phone (signed out) projects the committed claim onto the pass
// doc so the pass page stamps at scan time. Values must be an exact copy
// of the claim's; anything else is forgery and must fail.
const FIXED = new Date("2026-11-27T17:33:00.000Z");
const seedProjection = () => env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await db.doc(`gp_gates/${CODE}/claims/${PASS}`).set({
    eventId: EV2, token: TOKEN, name: "Test One", gate: "Gate 1", device: "dev", scannedAt: FIXED,
  });
  await db.doc(`gp_passes/${TOKEN}`).set({ id: PASS, eventId: EV2, name: "Test One", checkedInAt: null, gate: "" });
});

test("P1. unauthenticated exact claim projection succeeds", async () => {
  await seedProjection();
  await assertSucceeds(as(null).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: FIXED, gate: "Gate 1" }));
});

test("P2. projection with a different time fails", async () => {
  await seedProjection();
  await assertFails(as(null).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: new Date("2026-11-27T17:34:00.000Z"), gate: "Gate 1" }));
});

test("P3. projection with a different gate fails", async () => {
  await seedProjection();
  await assertFails(as(null).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: FIXED, gate: "Gate 9" }));
});

test("P4. projection onto an already-stamped pass fails", async () => {
  await seedProjection();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`gp_passes/${TOKEN}`).set({ id: PASS, eventId: EV2, name: "Test One", checkedInAt: FIXED, gate: "Gate 1" });
  });
  await assertFails(as(null).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: FIXED, gate: "Gate 1" }));
});

test("P5. projection touching another field fails", async () => {
  await seedProjection();
  await assertFails(as(null).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: FIXED, gate: "Gate 1", name: "Forged" }));
});

test("P6. projection with no claim fails", async () => {
  await seedProjection();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`gp_gates/${CODE}/claims/${PASS}`).delete();
  });
  await assertFails(as(null).doc(`gp_passes/${TOKEN}`).update({ checkedInAt: FIXED, gate: "Gate 1" }));
});

// ── Offline flush window (claim / repeat creates) ──
// A gate phone that scanned with no signal replays the scan when signal
// returns, and the claim must carry the ORIGINAL scan instant — so a
// non-owner create may be backdated within a bounded window. Every other
// guard (one-shot, token↔pass match, approved RSVP) is unchanged.
const PASS2 = "pass-v2-b", TOKEN2 = "C".repeat(32);
const seedClaimable = () => env.withSecurityRulesDisabled(async (ctx) => {
  await ctx.firestore().doc(`gp_passes/${TOKEN2}`).set({ id: PASS2, eventId: EV2, name: "Test Two", checkedInAt: null, gate: "" });
});
const claimBody = (scannedAt) => ({ eventId: EV2, token: TOKEN2, name: "Test Two", gate: "Gate 1", device: "dev", scannedAt });

test("C1. unauthenticated claim create at ~now succeeds", async () => {
  await seedClaimable();
  await assertSucceeds(as(null).doc(`gp_gates/${CODE}/claims/${PASS2}`).set(claimBody(new Date())));
});

test("C2. claim create backdated 2h (offline flush) succeeds", async () => {
  await seedClaimable();
  await assertSucceeds(as(null).doc(`gp_gates/${CODE}/claims/${PASS2}`).set(claimBody(new Date(Date.now() - 2 * 3600e3))));
});

test("C3. claim create backdated 8 days fails (outside the window)", async () => {
  await seedClaimable();
  await assertFails(as(null).doc(`gp_gates/${CODE}/claims/${PASS2}`).set(claimBody(new Date(Date.now() - 8 * 24 * 3600e3))));
});

test("C4. claim create with a future scannedAt fails", async () => {
  await seedClaimable();
  await assertFails(as(null).doc(`gp_gates/${CODE}/claims/${PASS2}`).set(claimBody(new Date(Date.now() + 3600e3))));
});

test("C5. repeat create backdated 2h succeeds against an existing claim", async () => {
  // the main seed already wrote claims/${PASS}
  await assertSucceeds(as(null).collection(`gp_gates/${CODE}/claims/${PASS}/repeats`).add({
    eventId: EV2, gate: "Gate 1", device: "dev", scannedAt: new Date(Date.now() - 2 * 3600e3),
  }));
});

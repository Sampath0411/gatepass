// Rules tests for the paid-passes order guards (docs/paid-passes.md):
// a member's own RSVP writes may start an order 'unpaid' and later move
// it to 'client_paid_unverified', but may NEVER set 'verified' (that is
// the verifier Cloud Function's write, via the Admin SDK) nor create an
// RSVP already claiming a payment. Plus the gp_config/public contract:
// world-readable, writable by nobody from a client.
// Run with the Firestore emulator on 127.0.0.1:8080: npm run test:rules
// (this file is picked up alongside firestore.test.js by node --test
// when invoked directly: node --test payments-rules.test.js).
import { test, before, after, beforeEach, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";

const PROJECT = "gatepass-test", OWNER = "owner-uid", MEMBER = "member-uid";
const EV = "event-paid", EVA = "event-paid-approval";
let env;

const rsvp = (over = {}) => ({
  name: "Buyer", email: "buyer@x.com", phone: "", college: "",
  answers: {}, via: "account", status: "pending",
  amount_paise: 20000, currency: "INR",
  pay_status: "unpaid", razorpay_payment_id: null,
  ...over,
});

const seed = () => env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await db.doc(`gp_events_v2/${EV}`).set({ ownerId: OWNER, gateCode: "CODEPAY1", title: "Paid", visibility: "public", price: "200", approval: false, capacity: 0 });
  await db.doc(`gp_events_v2/${EVA}`).set({ ownerId: OWNER, gateCode: "CODEPAY2", title: "Paid Approval", visibility: "public", price: "150", approval: true, capacity: 0 });
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
const myRsvp = (db, ev = EV) => db.doc(`gp_rsvps/${ev}/rsvps/${MEMBER}`);

test("R1. member creates own RSVP with an unpaid order", async () => {
  await assertSucceeds(myRsvp(as(MEMBER)).set(rsvp()));
});

test("R2. member may NOT create an RSVP already claiming a client payment", async () => {
  await assertFails(myRsvp(as(MEMBER)).set(rsvp({ pay_status: "client_paid_unverified", razorpay_payment_id: "pay_x" })));
});

test("R3. member may NOT create an RSVP claiming verified", async () => {
  await assertFails(myRsvp(as(MEMBER)).set(rsvp({ pay_status: "verified", razorpay_payment_id: "pay_x" })));
});

test("R4. member may NOT attach a payment id at create time", async () => {
  await assertFails(myRsvp(as(MEMBER)).set(rsvp({ razorpay_payment_id: "pay_x" })));
});

test("R5. member creates an RSVP with no payment fields at all (free-event shape)", async () => {
  const { amount_paise, currency, pay_status, razorpay_payment_id, ...plain } = rsvp();
  await assertSucceeds(myRsvp(as(MEMBER)).set(plain));
});

test("R6. member moves own order unpaid → client_paid_unverified after checkout", async () => {
  const db = as(MEMBER);
  await assertSucceeds(myRsvp(db).set(rsvp()));
  await assertSucceeds(myRsvp(db).update({ pay_status: "client_paid_unverified", razorpay_payment_id: "pay_real" }));
});

test("R7. member may NOT move own order to verified", async () => {
  const db = as(MEMBER);
  await assertSucceeds(myRsvp(db).set(rsvp()));
  await assertFails(myRsvp(db).update({ pay_status: "verified" }));
});

test("R8. a verified order is frozen for the member: details editable, status untouchable", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`gp_rsvps/${EV}/rsvps/${MEMBER}`).set(rsvp({ pay_status: "verified", razorpay_payment_id: "pay_real", status: "approved" }));
  });
  const db = as(MEMBER);
  await assertSucceeds(myRsvp(db).update({ name: "New Name" }));
  await assertFails(myRsvp(db).update({ pay_status: "unpaid" }));
  await assertFails(myRsvp(db).update({ pay_status: "client_paid_unverified" }));
});

test("R9. gp_config/public: anyone may read, nobody may write from a client", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc("gp_config/public").set({ razorpayKeyId: "rzp_test_x" });
  });
  await assertSucceeds(as(null).doc("gp_config/public").get());
  await assertFails(as(OWNER).doc("gp_config/public").set({ razorpayKeyId: "rzp_test_y" }));
  await assertFails(as(null).doc("gp_config/private").get());
});

test("R10. approval event: pay fields ride along, approval guard still intact", async () => {
  const db = as(MEMBER);
  await assertSucceeds(myRsvp(db, EVA).set(rsvp({ amount_paise: 15000 })));
  // Payment lands before approval: pay-only update, status stays pending.
  await assertSucceeds(myRsvp(db, EVA).update({ pay_status: "client_paid_unverified", razorpay_payment_id: "pay_a" }));
  // …but the member still cannot approve themselves.
  await assertFails(myRsvp(db, EVA).update({ status: "approved" }));
});

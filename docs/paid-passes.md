# Paid passes — Razorpay go-live guide

GatePass events with a price (anything that parses to a positive amount:
`200`, `₹200`, `200/-`, `1,200`) are **paid events**. Free events are
completely untouched by everything in this document.

## How it works (the state machine)

An order lives on the member's RSVP doc (`gp_rsvps/{eventId}/rsvps/{uid}`)
in these fields: `amount_paise`, `currency: "INR"`, `pay_status`,
`razorpay_payment_id`, `pay_updated_at`.

```
RSVP ──► pay_status "unpaid"            (no pass, no spot consumed)
  │
  ├─ checkout dismissed / failed ──► stays "unpaid" (Pay button retries)
  │
  └─ checkout success (browser) ──► pay_status "client_paid_unverified"
  │                                   + the status decision, made WITH
  │                                     the payment on record:
  │                                     approval event → stays "pending"
  │                                     full event     → "waitlisted"
  │                                     otherwise      → pass issued
  │
  └─ verifier function (server) ──► pay_status "verified"
                                    or "verification_failed"
```

## The one rule that matters

**A payment reported by the browser is NOT proof of payment.** Anyone
with devtools can fire the checkout success callback (or write
`client_paid_unverified` to their own RSVP — the rules deliberately
allow exactly that transition and no further). That is why:

- the dashboard labels these orders **PAID (UNVERIFIED)** and the total
  **"Collected (client-reported)"**,
- the rules make it impossible for a member to write `"verified"`
  themselves (create must start `unpaid` with no payment id; the only
  transitions a member can make are `unpaid → client_paid_unverified`;
  a verified order is frozen for the member),
- and **you must deploy the verifier below before trusting any of it
  for real money.** Until then, reconcile every order against the
  Razorpay dashboard by payment id before treating it as paid.

## Go-live checklist

### 1. Razorpay account

1. Sign up at razorpay.com and complete KYC (needed for live payments;
   test mode works without it).
2. Settings → API Keys → generate a key pair. You get a **Key ID**
   (`rzp_live_…` / `rzp_test_…`) and a **Key Secret**.

### 2. Put the KEY ID where the site can read it (never the secret)

Either place works; the deployment config wins:

- **firebase-config.js** — uncomment/add `razorpayKeyId: "rzp_live_…"`
  in the `window.FIREBASE` object (or set
  `window.GP_RAZORPAY_KEY_ID = "rzp_live_…";`), then redeploy; **or**
- **Firestore, no redeploy** — create the document `gp_config/public`
  with one field: `razorpayKeyId: "rzp_live_…"`. The rules make this
  document world-readable and client-unwritable, so only someone with
  Firebase console access (you) can set it.

> ⚠️ The Key **Secret** must never go in either place, nor anywhere in
> this repo. It belongs only in the verifier function's secret store
> (step 3). If it ever leaks, roll the key pair in Razorpay's dashboard.

Until a key ID is configured, a paid event records RSVPs as unpaid and
tells the member *"Payments aren't switched on for this event yet —
please contact the organiser."* No pass is ever issued for free by
accident.

### 3. Publish the Firestore rules

The repo's `firestore.rules` already contains the member pay guards
(create starts `unpaid`, no `verified` from clients) and the
`gp_config/public` read. Publish them the same way as the last rules
update (Firebase console → Firestore Database → Rules → Publish, or
`firebase deploy --only firestore:rules`).

### 4. Deploy the verifier Cloud Function

This is the piece that turns "client-reported" into "verified". It
watches RSVP docs; whenever one lands on `client_paid_unverified`, it
checks the payment **with Razorpay's API using the secret** (and the
checkout signature too, when the client recorded one) and flips the
order to `verified` — or to `verification_failed` with a reason.

Setup once:

```bash
firebase init functions        # if the project has none yet; Node 20, javascript
cd functions
npm install firebase-functions@latest firebase-admin@latest
firebase functions:secrets:set RAZORPAY_KEY_ID
firebase functions:secrets:set RAZORPAY_KEY_SECRET
```

`functions/index.js`:

```js
// Verifies browser-reported Razorpay payments server-side.
// The key SECRET lives only here (Secret Manager) — never in client
// code, never in Firestore. Admin SDK writes bypass the security
// rules, which is exactly why "verified" can be trusted: the rules
// refuse it from every client.
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("node:crypto");

initializeApp();
const KEY_ID = defineSecret("RAZORPAY_KEY_ID");
const KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");

exports.verifyGatepassPayment = onDocumentUpdated(
  {
    document: "gp_rsvps/{eventId}/rsvps/{uid}",
    secrets: [KEY_ID, KEY_SECRET],
  },
  async (event) => {
    const after = event.data.after.data();
    if (!after || after.pay_status !== "client_paid_unverified") return;
    const paymentId = after.razorpay_payment_id;
    const ref = event.data.after.ref;
    const fail = async (reason) => {
      console.warn("payment verification failed", { paymentId, reason });
      await ref.update({
        pay_status: "verification_failed",
        verify_error: String(reason).slice(0, 200),
        pay_updated_at: FieldValue.serverTimestamp(),
      });
    };
    if (!paymentId) return fail("missing payment id");

    const secret = KEY_SECRET.value();

    // (a) Signature check, when the checkout recorded one. Only
    // possible when an order id exists; this build's client flow has
    // none, so (b) is the primary check and this is belt-and-braces
    // for a future server-created-orders flow.
    if (after.razorpay_order_id && after.razorpay_signature) {
      const expected = crypto
        .createHmac("sha256", secret)
        .update(`${after.razorpay_order_id}|${paymentId}`)
        .digest("hex");
      const got = Buffer.from(String(after.razorpay_signature));
      const want = Buffer.from(expected);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
        return fail("signature mismatch");
      }
    }

    // (b) Ask Razorpay directly, with the secret: does this payment
    // exist, is it captured, and is it for the amount on the order?
    const auth = Buffer.from(`${KEY_ID.value()}:${secret}`).toString("base64");
    const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) return fail(`razorpay api ${res.status}`);
    const p = await res.json();
    if (p.status !== "captured" && p.status !== "authorized") {
      return fail(`payment status ${p.status}`);
    }
    if (p.amount !== after.amount_paise) {
      return fail(`amount mismatch: paid ${p.amount}, order ${after.amount_paise}`);
    }
    if (p.currency !== "INR") return fail(`currency ${p.currency}`);

    await ref.update({
      pay_status: "verified",
      verified_at: FieldValue.serverTimestamp(),
      pay_updated_at: FieldValue.serverTimestamp(),
    });
    console.log("payment verified", { paymentId });
  }
);
```

Deploy and watch it work:

```bash
firebase deploy --only functions
firebase functions:log
```

Test end-to-end in **test mode** first: put the `rzp_test_…` key ID on
the site, RSVP to a paid event, pay with Razorpay's test card
`4111 1111 1111 1111` (any future expiry/CVV). The order appears as
PAID (UNVERIFIED); within seconds of the function running it flips to
PAID (VERIFIED) on the dashboard.

No rules change is needed for the function: it writes with the Admin
SDK, which bypasses the rules — and the rules' member guards are what
make its `verified` write meaningful.

## Honest limits

- **Until the verifier is deployed, client-reported payments can be
  faked.** A faker gets a real pass and an UNVERIFIED order. Treat
  UNVERIFIED as "probably paid", reconcile against Razorpay's own
  dashboard for anything that matters, and deploy the verifier before
  a real paid event.
- **Refunds happen in Razorpay's dashboard**, not in GatePass. A refund
  does not revoke the pass — reject/remove the member in GatePass
  yourself if a refunded attendee should lose entry. Chargebacks are
  the same story.
- **The pass may already be issued when verification fails** (the
  member paid at the door, so to speak). `verification_failed` orders
  show as **Unpaid** on the dashboard; check the member list before the
  event and decide case by case.
- **Amounts** are stamped from the event's price at RSVP time and
  re-stamped with the charged amount at checkout. If you change the
  price mid-sale, earlier orders keep the price those members actually
  paid — that is deliberate.
- **Capacity is client-enforced**, same as the waitlist: a payer who
  completes checkout as the event fills is waitlisted with their
  payment recorded, and promoted (pass issued) when a spot frees.
- Razorpay's fees (~2%) and GST invoicing to attendees are yours to
  handle in Razorpay/your books; GatePass does not generate invoices.
- This build does not create Razorpay **Orders** server-side (that is
  what would enable signature-first verification and webhooks). The
  verifier above is written so adding Orders later only strengthens
  check (a); check (b) already stands on its own.

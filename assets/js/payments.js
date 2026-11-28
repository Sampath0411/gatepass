// Paid passes — Razorpay checkout glue + the ONE price parser.
//
// This module also hosts parsePricePaise so firebase.js (which stamps the
// order amount onto the RSVP) and the UI share exactly one implementation
// of what "paid" means. It has no imports on purpose: the parser stays
// unit-testable in plain Node.
//
// ── Honesty rules (do not soften) ──────────────────────────────────────
// 1. Only the Razorpay KEY ID is public. The key SECRET must never appear
//    in client code, in firebase-config.js, or in any Firestore document
//    a member can read. It belongs to the verifier Cloud Function only.
// 2. A payment the BROWSER reports is not proof of payment. The checkout
//    handler callback can be forged by anyone with devtools, so a success
//    here is recorded as "client_paid_unverified" — never "verified".
//    Only the server-side verifier (docs/paid-passes.md) may flip an
//    order to "verified", after checking the payment with Razorpay's API
//    (and the webhook signature, when present) using the secret.
// 3. No key ID configured ⇒ no checkout, no pass. The RSVP is recorded
//    as unpaid and the member is told payments aren't switched on yet.

// The event's `price` field is a free-form string from the create/edit
// form ("Free", "200", "₹200", "200/-", "1,200"). A positive parsed
// amount makes the event paid; anything else (Free / 0 / empty /
// unparseable) is a free event and the payment flow never engages.
export function parsePricePaise(price) {
  const s = String(price ?? "").trim();
  if (!s || /^free$/i.test(s)) return 0;
  const cleaned = s.replace(/[₹$,]/g, "").replace(/\/-\s*$/, "").trim();
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

export const isPaidPrice = (price) => parsePricePaise(price) > 0;

// Paise → display rupees: whole rupees print without paise (₹200),
// anything else keeps two decimals (₹99.50).
export function formatPaise(paise) {
  const n = Number(paise) || 0;
  const rupees = n / 100;
  return "₹" + (Number.isInteger(rupees)
    ? rupees.toLocaleString("en-IN")
    : rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
let loadPromise = null;
let docKey;   // gp_config/public fallback, resolved at most once per page

// The key ID from this deployment's own config (firebase-config.js):
// either the dedicated global or a field on the Firebase config object.
// Both are publishable values — a key ID identifies the account, it does
// not authorise anything by itself.
export function razorpayKeyId() {
  if (typeof window === "undefined") return "";
  return String(window.GP_RAZORPAY_KEY_ID || window.FIREBASE?.razorpayKeyId || "").trim();
}

// Full resolution: deployment config first, then the gp_config/public
// Firestore doc (which the owner can set from the Firebase console
// without a redeploy — it holds the public key ID only, never a secret).
// `getPublicConfig` is injected (firebase.js) to keep this module
// dependency-free.
export async function resolveRazorpayKeyId(getPublicConfig) {
  const own = razorpayKeyId();
  if (own) return own;
  if (docKey !== undefined) return docKey;
  docKey = "";
  try {
    const cfg = await getPublicConfig?.();
    if (cfg?.razorpayKeyId) docKey = String(cfg.razorpayKeyId).trim();
  } catch { /* an unreadable config doc is just "not configured" */ }
  return docKey;
}

// Load checkout.js on demand — only ever called for paid events when a
// key ID exists, so free-event pages never fetch Razorpay's script.
export function loadCheckout() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Checkout is only available in the browser"));
  }
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (!loadPromise) {
    loadPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = CHECKOUT_SRC;
      s.async = true;
      s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error("Razorpay checkout failed to load")));
      s.onerror = () => { loadPromise = null; reject(new Error("Razorpay checkout failed to load")); };
      document.head.append(s);
    });
  }
  return loadPromise;
}

// Open the Razorpay modal. Resolves { paymentId, orderId, signature } on
// the handler callback — CLIENT-REPORTED, unverified (see the header) —
// or null when the member dismisses the modal or the payment fails, so
// callers can leave the order unpaid and offer a retry.
export async function openCheckout({ keyId, amountPaise, title, name, email, phone }) {
  const Razorpay = await loadCheckout();
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const rzp = new Razorpay({
      key: keyId,
      amount: amountPaise,
      currency: "INR",
      name: "GatePass",
      description: title || "Event pass",
      prefill: { name: name || "", email: email || "", contact: phone || "" },
      theme: { color: "#1A43B4" },
      handler: (resp) => done({
        paymentId: resp?.razorpay_payment_id || null,
        orderId: resp?.razorpay_order_id || null,
        signature: resp?.razorpay_signature || null,
      }),
      modal: { ondismiss: () => done(null) },
    });
    if (typeof rzp.on === "function") rzp.on("payment.failed", () => done(null));
    rzp.open();
  });
}

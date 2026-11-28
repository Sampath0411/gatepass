// =============================================================================
// WARNING — YOU MUST REPLACE THESE VALUES BEFORE FORKING / SELF-HOSTING
// -----------------------------------------------------------------------------
// This file ships pointing at the author's Firebase project. If you fork or
// host your own copy, you MUST replace ALL of the values below with your own
// Firebase project's web config. Otherwise your data will be written to someone
// else's project, and Google sign-in will FAIL because your domain is not an
// authorised domain on that project. Get your config from the Firebase console:
// Project settings -> Your apps -> SDK setup and configuration.
// =============================================================================
// GatePass Firebase configuration. This is the only file you edit to use your own project.
// These values are public by design; Firestore Security Rules protect the data.
// Never put a service-account key or any secret here.
window.FIREBASE = {
  apiKey: "AIzaSyDDhLEv48jfWKGWWfLW3wDjlZ6zAgD4hek",
  authDomain: "fest-website-8dcd7.firebaseapp.com",
  projectId: "fest-website-8dcd7",
  storageBucket: "fest-website-8dcd7.firebasestorage.app",
  messagingSenderId: "554053980634",
  appId: "1:554053980634:web:081d4676b86b394a06b0e3",
  // OAuth client ID (Web application) for the organiser's Google Sheet access.
  // Google Cloud → APIs & Services → Credentials; authorised origin = your deployed domain.
  googleOAuthClientId: "646944374445-ecs2s80bs5kqlpm5heu8ksuglod2nrpr.apps.googleusercontent.com",
  // Optional: Razorpay KEY ID for paid passes (docs/paid-passes.md). The
  // key ID is a public identifier — safe to ship here. The key SECRET
  // must NEVER be put in this file (or anywhere client-side); it belongs
  // only to the payment-verifier Cloud Function. Until a key ID is set,
  // paid events record RSVPs as unpaid and tell members payments aren't
  // switched on yet. Alternatively set the key ID without a redeploy in
  // Firestore: gp_config/public → razorpayKeyId.
  // razorpayKeyId: "rzp_test_...",
};
// The payments module also honours a standalone global, if you prefer:
// window.GP_RAZORPAY_KEY_ID = "rzp_test_...";

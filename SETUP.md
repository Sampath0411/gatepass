# Firebase setup for GatePass

1. Open the Firebase console for your project. Enable **Firestore Database** (production mode) and choose a region.
2. Enable **Authentication → Sign-in method → Google**, set a support email, and add your deployed domain under **Authorised domains**.
3. Publish `firestore.rules` (Firebase CLI `firebase deploy --only firestore:rules`, or paste into the Rules tab) and `firestore.indexes.json` (`firebase deploy --only firestore:indexes`).
4. Copy the web app config into `firebase-config.js`.
5. Deploy to GitHub Pages or Firebase Hosting. No build step is needed.
6. Sign in with Google, create an event, upload a small CSV, and test with two phones before the real event.

## Data layout
All collections are prefixed `gp_` so the project can be shared. The gate code and pass token are capabilities: staff and attendees need no account. The one accepted scan per pass is enforced by the claim document ID and by Security Rules.

# Firebase setup for GatePass

1. Open the Firebase console for your project. Enable **Firestore Database** (production mode) and choose a region.
2. Enable **Authentication → Sign-in method → Google**, set a support email, and add your deployed domain under **Authorised domains**.
3. Publish `firestore.rules` (Firebase CLI `firebase deploy --only firestore:rules`, or paste into the Rules tab) and `firestore.indexes.json` (`firebase deploy --only firestore:indexes`). Before any `firebase deploy`, run `firebase login`, then select your project with `firebase use --add` (or `firebase use <your-project-id>`) — no project is hard-coded in this repo. A root `firebase.json` points the CLI at the rules, indexes and site root.
4. Copy your web app config into `firebase-config.js`. It ships pointing at the author's project, so you must replace every value with your own (Firebase console → Project settings → Your apps → SDK setup and configuration) or sign-in fails on an unauthorised domain and your data lands in someone else's project.
5. Deploy to GitHub Pages or Firebase Hosting (`firebase deploy --only hosting`, after the login/use from step 3). No build step is needed.
6. Sign in with Google, create an event, upload a small CSV, and test with two phones before the real event.

## Troubleshooting: "The database is temporarily unavailable"

If a signed-in organiser gets stuck loading an event, or sees this message, the Firestore client could not reach the backend. The usual cause is that **Cloud Firestore has not been enabled** for the project in `firebase-config.js` — the SDK then reports `5 NOT_FOUND` and goes permanently offline, so reads never settle.

Fix:

1. Firebase console → your project → **Build → Firestore Database → Create database**. Choose **production mode** and a region. This is a one-time step per project.
2. Paste `firestore.rules` into the **Rules** tab and publish (or use the CLI command in step 3 above).
3. **Authentication → Settings → Authorised domains** must include the domain you are serving from (`localhost` for local testing, your GitHub Pages / Hosting domain in production), and the Google provider must be enabled.
4. Confirm `firebase-config.js` contains the web config of the **same project** where you enabled Firestore. A config copied from another project will sign you in but read/write a project with no database.
5. Hard-refresh the page (Ctrl/Cmd+Shift+R) to clear the cached JS, then try again.

## Data layout
All collections are prefixed `gp_` so the project can be shared. The gate code and pass token are capabilities: staff and attendees need no account. The one accepted scan per pass is enforced by the claim document ID and by Security Rules.

## Automated E2E check (Firestore emulator)

The duplicate-scan test seeds one event and one pass in a local emulator on port **8081** (the rules tests in `tests/firestore.test.js` use 8080), then drives two independent gate phones. It overrides the Firebase config and injects `connectFirestoreEmulator` from the test only — no source file is changed.

Node / Playwright (run from `tests/` so Node resolves the local package):

```sh
cd tests
npm ci
npx playwright install chromium
npm run test:e2e
# or: npx playwright test e2e/duplicate-scan.spec.js
```

Python Playwright fallback (uses the already-installed system Python package; run from the **repo root**):

```sh
python tests/e2e/duplicate_scan.py
```

Run the Node command from `tests/`, not from the repo root. With dependencies installed only in `tests/`, a root-level `npx playwright test tests/e2e/duplicate-scan.spec.js` makes npx load a second copy of Playwright and the runner rejects the test file. To use that root-level form, Playwright must also be installed at the repo root.

Both start their own emulator and static server. Set `GP_E2E_FIRESTORE_PORT` to change the port, or `GP_E2E_EMULATOR=0` to reuse an emulator already running there.

## Manual smoke checklist (real Firebase project)

Run this once against the deployed project before an event. Keep two phones (or two browser profiles) handy for the gate steps.

- [ ] **Google sign-in** — open the site, tap *Continue with Google*, sign in, and land on the event list with no console errors.
- [ ] **Create event** — add an event with a name, club, venue, date and artwork; confirm it appears in the list with a gate code.
- [ ] **Paste 3 rows** — paste three `name, contact` rows into the registrations box; confirm all three are parsed and previewed.
- [ ] **Generate passes** — create the passes; confirm the row count becomes 3 and each row has its own QR/link.
- [ ] **Copy link** — copy one pass link and open it in another browser/profile; confirm the ticket shows the right name and event.
- [ ] **Join gate** — on a second device open `/gate/`, enter the 8-character gate code, pick *Gate 1*, and confirm the counter reads `0 / 3`.
- [ ] **Scan pass (green)** — scan/copy that pass's QR text into the gate; verdict reads *First scan* with the green `ok` style and the counter becomes `1 / 3`.
- [ ] **Rescan (red)** — scan the same pass again (from the same or a different gate phone); verdict reads *Already scanned* with the red `dup` style, names the first gate, and the checked-in count stays `1 / 3` while `bounced` increases.
- [ ] **Rotate code** — on the organiser page rotate the gate code; confirm the old code is rejected by an already-joined gate phone ("organiser changed this gate's code") and the new code joins successfully with existing scans/counts intact.
- [ ] **Delete event** — delete the event; confirm it disappears from the list and its gate code and pass links no longer resolve.

# Firebase setup for GatePass

1. Open the Firebase console for your project. Enable **Firestore Database** (production mode) and choose a region.
2. Enable **Authentication → Sign-in method → Google**, set a support email, and add every domain you will serve from under **Authorised domains** (your deployed domain, plus `localhost` for local testing). Students registering for a fest sign in with Google too, so every host domain must be listed here.
3. Publish `firestore.rules` (Firebase CLI `firebase deploy --only firestore:rules`, or paste into the Rules tab) and `firestore.indexes.json` (`firebase deploy --only firestore:indexes`). Before any `firebase deploy`, run `firebase login`, then select your project with `firebase use --add` (or `firebase use <your-project-id>`) — no project is hard-coded in this repo. A root `firebase.json` points the CLI at the rules, indexes and site root.
4. Copy your web app config into `firebase-config.js`. It ships pointing at the author's project, so you must replace every value with your own (Firebase console → Project settings → Your apps → SDK setup and configuration) or sign-in fails on an unauthorised domain and your data lands in someone else's project.
5. Deploy to GitHub Pages, Firebase Hosting (`firebase deploy --only hosting`, after the login/use from step 3), or Vercel (`vercel --prod --yes`). No build step is needed. Whatever host you choose, add its domain to **Authentication → Settings → Authorised domains** in Firebase — Google sign-in will fail on an unlisted domain even if the page loads.
6. Sign in with Google, create an event, upload a small CSV, and test with two phones before the real event.

## Fests, sub-events and public registration

1. On the organiser dashboard open **Your events**, tap **Fests**, then tap **New fest** — name, club, venue and date.
2. Open the fest and tap **Add sub-event** for each programme/day. Every sub-event automatically gets its own 8-character gate code and a public **Register link**.
3. Share a sub-event's **Register link** with students. They sign in with Google, enter their name (email and phone are optional), and land straight on their pass. Use **Close registration** / **Open registration** on a sub-event to control sign-ups.
4. The fest's **All registrations** table shows every sub-event's sign-ups in one place, with a CSV export. The pass link in each row opens that student's QR pass.

## Direct Google Sheet writes (OAuth client ID)

Fest registrations can append straight to a Google Sheet from the organiser's browser — no server, API key or Apps Script. You need a Google Cloud OAuth client ID for the **organiser's** Google account:

1. **Enable the API:** in [Google Cloud Console](https://console.cloud.google.com) select the same project as your Firebase app → **APIs & Services → Library** → enable **Google Sheets API**.
2. **Consent screen:** **APIs & Services → OAuth consent screen**. Choose **External** (or Internal for a workspace), fill in the app name and support email, and add the scope `https://www.googleapis.com/auth/spreadsheets`. If the app is in *Testing*, add the organiser's Google account under **Test users** or sign-in will be blocked.
3. **Create the client ID:** **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorised JavaScript origins** add every origin that serves the site — your deployed domain (e.g. `https://your-site.vercel.app` or `https://<you>.github.io`) and `http://localhost:8000` (or whichever port you use locally), with no trailing path. **Authorised redirect URIs** are not needed for this flow.
4. **Paste the ID** into `googleOAuthClientId` in [`firebase-config.js`](firebase-config.js) (it ships empty). This value is public, like the Firebase web config; the OAuth consent screen and Sheets permissions are what protect the Sheet.
5. **In the fest dashboard**, paste the full Sheet URL (or its ID) into **Sheet URL (or ID)** and the tab name/range into **Tab / range** (default `Registrations`), then tap **Save**. Tap **Connect Google Sheet** once per browser session and grant access to the Sheet.
6. **Caveat — live only while the dashboard is open.** The token and the `onSnapshot` listener live in the organiser's browser tab. Registrations append as they arrive **while that fest dashboard stays open**; closing the tab or losing the token pauses sync. Rows that were not appended stay marked **Pending** in the table and are appended (once each) when the dashboard is reopened and reconnected. Share the register link freely, but keep one organiser tab open during sign-up if you want the Sheet to stay live.

## Sync registrations from a Google Sheet (no API key)

This is the single-event flow: it *reads* a published sheet into the preview. It is separate from the fest's direct *append* described above.

1. In Google Sheets, open your responses sheet and use **File → Share → Publish to web** (or set sharing to Anyone with the link can view). A private sheet cannot be fetched.
2. In GatePass, open the event and tap **Or sync from a Google Sheet** under registrations. Paste the sheet link (the address-bar link is fine — a `?gid=` / `#gid=` tab is kept) and tap **Sync sheet**.
3. Review the preview exactly as for a file upload, pick the name/contact columns if needed, then tap **Generate**. Rows already on the list are skipped; nothing existing is wiped.
4. When new Form responses arrive, tap **Sync sheet** again (the link is remembered in that browser) and generate the new passes.
5. If the sync fails, the message says why — usually the sheet isn't published yet. The paste-rows box is the fallback: copy the cells in Sheets and paste them there.

## Troubleshooting: "The database is temporarily unavailable"

If a signed-in organiser gets stuck loading an event, or sees this message, the Firestore client could not reach the backend. The usual cause is that **Cloud Firestore has not been enabled** for the project in `firebase-config.js` — the SDK then reports `5 NOT_FOUND` and goes permanently offline, so reads never settle.

Fix:

1. Firebase console → your project → **Build → Firestore Database → Create database**. Choose **production mode** and a region. This is a one-time step per project.
2. Paste `firestore.rules` into the **Rules** tab and publish (or use the CLI command in step 3 above).
3. **Authentication → Settings → Authorised domains** must include the domain you are serving from (`localhost` for local testing, your GitHub Pages / Hosting domain in production), and the Google provider must be enabled.
4. Confirm `firebase-config.js` contains the web config of the **same project** where you enabled Firestore. A config copied from another project will sign you in but read/write a project with no database.
5. Hard-refresh the page (Ctrl/Cmd+Shift+R) to clear the cached JS, then try again.

## Data layout
All collections are prefixed `gp_` so the project can be shared. The gate code and pass token are capabilities: staff and attendees need no account. The one accepted scan per pass is enforced by the claim document ID and by Security Rules. Phase A adds `gp_fests`, `gp_fests/{festId}/events`, `gp_fests/{festId}/registrations`, `gp_fests/{festId}/events/{eventId}/passes` (owner-only pass details), `gp_reg_public` (signed-in-readable descriptor) and `gp_users/{uid}/fests` (owner's fest index). Students write their own pass + registration with their uid; fest registrations are readable only by the fest owner; the public `gp_passes/{token}` doc never stores the gate code.

## Automated E2E check (Firestore emulator)

The duplicate-scan test seeds one event and one pass in a local emulator on port **8081** (the rules tests in `tests/firestore.test.js` use 8080), then drives two independent gate phones. The registration test seeds a fest + open sub-event on port **8082**, signs in a student and an organiser with stubbed Auth, stubs the Google Sheets API, and checks the pass page, the registrations table and a single Sheets append. Both override the Firebase config and inject `connectFirestoreEmulator` from the test only — no source file is changed. `npm run test:e2e` runs both specs with one worker (two emulators at once can race on Windows temp-file cleanup).

Node / Playwright (run from `tests/` so Node resolves the local package):

```sh
cd tests
npm ci
npx playwright install chromium
npm run test:e2e
# or one spec at a time:
# npx playwright test e2e/duplicate-scan.spec.js
# npx playwright test e2e/registration.spec.js
```

Python Playwright fallback (uses the already-installed system Python package; run from the **repo root**):

```sh
python tests/e2e/duplicate_scan.py
```

Run the Node command from `tests/`, not from the repo root. With dependencies installed only in `tests/`, a root-level `npx playwright test tests/e2e/duplicate-scan.spec.js` makes npx load a second copy of Playwright and the runner rejects the test file. To use that root-level form, Playwright must also be installed at the repo root.

Both start their own emulator and static server. Duplicate-scan uses `GP_E2E_FIRESTORE_PORT` / `GP_E2E_EMULATOR`; registration uses `GP_E2E_REG_FIRESTORE_PORT` / `GP_E2E_REG_EMULATOR` (set the `…_EMULATOR` variable to `0` to reuse an emulator already running on that port).

## Manual smoke checklist (real Firebase project)

Run this once against the deployed project before an event. Keep two phones (or two browser profiles) handy for the gate steps.

- [ ] **Google sign-in** — open the site, tap *Continue with Google*, sign in, and land on the event list with no console errors.
- [ ] **Create event** — add an event with a name, club, venue, date and artwork; confirm it appears in the list with a gate code.
- [ ] **Paste 3 rows** — paste three `name, contact` rows into the registrations box; confirm all three are parsed and previewed.
- [ ] **Generate passes** — create the passes; confirm the row count becomes 3 and each row has its own QR/link.
- [ ] **WhatsApp delivery** — confirm the WhatsApp box counts the phone rows, **Send next on WhatsApp** opens one chat with the pass link pre-filled, and **Copy all WhatsApp messages** copies every message. Rows with no phone are counted, not silently skipped.
- [ ] **Sheet sync** — paste a published Google Sheet link, tap **Sync sheet**, confirm the same preview appears with the 3 rows, and that syncing again with the same rows adds 0 new passes (duplicates skipped, existing passes untouched).
- [ ] **Copy link** — copy one pass link and open it in another browser/profile; confirm the ticket shows the right name and event.
- [ ] **Join gate** — on a second device open `/gate/`, enter the 8-character gate code, pick *Gate 1*, and confirm the counter reads `0 / 3`.
- [ ] **Scan pass (green)** — scan/copy that pass's QR text into the gate; verdict reads *First scan* with the green `ok` style and the counter becomes `1 / 3`.
- [ ] **Rescan (red)** — scan the same pass again (from the same or a different gate phone); verdict reads *Already scanned* with the red `dup` style, names the first gate, and the checked-in count stays `1 / 3` while `bounced` increases.
- [ ] **Rotate code** — on the organiser page rotate the gate code; confirm the old code is rejected by an already-joined gate phone ("organiser changed this gate's code") and the new code joins successfully with existing scans/counts intact.
- [ ] **Create fest + sub-event** — from **Fests**, make a fest and add a sub-event; confirm it has a gate code and a **Register link**.
- [ ] **Public registration** — open the Register link in another profile, sign in with Google, submit the form, and confirm the pass page shows the right name and event.
- [ ] **Registrations table** — back on the fest dashboard, confirm the row appears under **All registrations** and its pass link opens the same pass.
- [ ] **Direct Sheet append** — with a Sheet URL/range saved and the Google account connected, confirm one row appends with timestamp, fest, sub-event, name, email, phone and pass link, and the table flips to **Synced**. Close the tab, register a second student, reopen/reconnect, and confirm the pending row appends exactly once.
- [ ] **Delete event** — delete the event; confirm it disappears from the list and its gate code and pass links no longer resolve.

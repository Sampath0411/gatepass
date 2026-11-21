# GatePass

**Free QR entry passes for college club events.** Upload your registrations sheet and everyone gets their own pass. At the gate, any phone becomes the scanner. The first scan of a pass goes green; every scan after that goes red, on every phone at the gate, with the time and gate of the first scan. So a shared screenshot works once.

**Use it:** https://souradip121.github.io/gatepass/
**Or host your own copy for free** in five steps (below). No build step, no server, no paid plan.

<p>
  <img src="screenshots/organiser.png" alt="Organiser dashboard: event poster, registrations, Generate passes, Checked in counter" width="250">
  <img src="screenshots/pass.png" alt="Attendee pass: gig-poster ticket with a big QR and 'Show this at the gate'" width="250">
  <img src="screenshots/gate-red.png" alt="Gate scanner showing a repeat scan in red: Already scanned" width="250">
</p>

Made by [sampath.exe](https://github.com/sampath0411).

---

## How it works

| Who | What they do | Account? |
|---|---|---|
| **Organiser** | Signs in with Google, creates the event, uploads the registrations CSV (or pastes rows from Google Sheets). Gets one pass per row — copy/export the links, or tap the photo button on a row to share the full pass image (art, details and QR) straight to WhatsApp/email on mobile, or download it to attach manually. Watches "Checked in N / total" live. | Yes |
| **Attendee** | Opens their link, shows the ticket at the gate, and can share or download the full pass photo from the pass page. A screenshot works too, once. | No |
| **Gate staff** | Open `/gate/`, type the event's 8-character gate code, pick a gate name and point the camera at passes. "Find by name" covers dead phones. | No |

GatePass sends no email or messages itself. Each pass row has copy, WhatsApp, photo and email buttons. The email button copies the full pass photo (with that person's name and QR) to your clipboard and opens Gmail — paste it into the message (Ctrl+V, or long-press → Paste) to include the image. On mobile it can share the image directly through your phone's share sheet instead. Browsers cannot attach files through a compose link, so this paste step is necessary.

### Why a screenshot only works once

Every pass has a 32-character random token (192 bits), so links can't be guessed. When a gate scans a pass, Firestore runs a transaction that writes a **claim** to `gp_gates/{code}/claims/{passId}` — and the document ID **is** the pass ID, so there can be exactly one claim per pass. Security Rules independently refuse a second create at that path. If two gates scan the same pass in the same millisecond, only one claim can exist: the other scan gets the first scan's time and gate back and shows red. Repeat attempts are logged under that claim, so the organiser sees "3 repeat scans bounced at the gate".

### Security model

- **Firestore Security Rules** guard every collection. Organisers can only read and change their own data; event data lives in owner-scoped subcollections (`gp_users/{uid}/events`, `gp_events/{eventId}/passes`, and the gate's `roster`/`claims`). The gate code is never stored in a document an attendee can read.
- **Attendees** need no account. They read their pass from `gp_passes/{token}`, where the 32-character token (192 bits) is the document ID and the capability. It returns just that one pass (name, event, check-in time) and never contact details or anyone else's pass.
- **Gate staff** need no account either. The 8-character gate code is a path segment (`gp_gates/{code}`) acting as the capability — 31⁸ ≈ 850 billion combinations — and Rules only allow reading a gate doc that already exists, so codes can't be enumerated. The organiser can replace the code with one tap ("New code") and the old one stops working immediately. Staff search shows masked contacts only (`an•••@gmail.com`, `•••3210`).
- **One-shot claims** live at `gp_gates/{code}/claims/{passId}`; the document ID makes each claim unique and Security Rules enforce a single create.
- **The gate code is a full capability — guard it.** Anyone who holds the code can read that event's roster: attendee **names, masked contacts, pass tokens and the random device IDs** recorded on scans. Share the code only with gate staff you trust, and tap **New code** to revoke it immediately if it leaks.
- Only the **public web config** is in `firebase-config.js`. It's designed to be shared; no service-account keys or secrets ever go in this repo.

---

## Host your own copy (free, 5 steps)

You need a free [Firebase](https://firebase.google.com) account and a GitHub account (or Netlify / Vercel / Firebase Hosting). The console walkthrough is in [`SETUP.md`](SETUP.md); the short version:

> ⚠️ **Before you fork or host your own copy:** [`firebase-config.js`](firebase-config.js) ships pointing at the author's Firebase project. You **must** replace every value with your own project's web config, or your data will be written to someone else's project and Google sign-in will fail with an *unauthorised domain* error.

1. **Create a Firebase project.** console.firebase.google.com → **Add project**. Google Analytics is optional. Enable **Firestore Database** in production mode and pick a region close to your college.
2. **Turn on Google sign-in.** **Authentication → Sign-in method → Google**, set a support email, and add your deployed site's domain under **Authentication → Settings → Authorised domains**. The hosted copy uses Google only.
3. **Publish the rules and config.** Before any `firebase deploy`, run `firebase login`, then select your project with `firebase use --add` (or `firebase use <your-project-id>`) — no project is hard-coded in this repo. Deploy [`firestore.rules`](firestore.rules) and [`firestore.indexes.json`](firestore.indexes.json) (Firebase CLI `firebase deploy --only firestore:rules,firestore:indexes`, or paste the rules into the Rules tab). Fork this repo and copy your web app config into [`firebase-config.js`](firebase-config.js) — **Project settings → Your apps → SDK setup and configuration**.
4. **Publish the site.**
   - **GitHub Pages:** in your fork, **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**. Your site appears at `https://<you>.github.io/gatepass/`.
   - **Netlify / Vercel:** import the repo. There is no build command; the publish directory is the repo root.
   - **Firebase Hosting:** `firebase deploy --only hosting` with the repo root as the public directory (after the `firebase login` / `firebase use` from step 3).
5. **Test it.** Sign in with Google, make an event, upload a small CSV, and do a test scan with two phones before the real event.

### Free-tier notes

- **No pausing.** Firestore on the free Spark plan doesn't go to sleep, so passes and scans work whenever your event is — no "restore project" the morning of the fest. A quick test scan the day before is still a good idea.
- **Google sign-in, no mailer limits.** Organisers sign in with their Google account, so GatePass sends no sign-in email — no mail quota, SMTP setup or "team members only" restriction to worry about.
- **Size:** the free Firestore plan holds far more than a fest needs; 5,000 people uses just a few MB.
- **Realtime:** the organiser's live counter and the gate phones' counts use Firestore realtime listeners (`onSnapshot`), all within the free plan.

---

## At the gate

- **Use Chrome or Safari**, not the Instagram/WhatsApp in-app browser: in-app browsers often block the camera. Allow camera access when asked.
- Each phone picks a **gate name** (Gate 1, Gate 2, Desk). Repeat scans show which gate let the pass in first.
- **Green** = let them in. **Red** = this pass was already used; the screen shows when and where. **Pink** = not a pass for this event.
- **Torch** and **switch camera** buttons appear on phones that support them.
- The **magnifier** on the camera window finds a guest by name, for a dead phone or a cracked screen (check ID). The **camera** icon scans a photo of a pass if the live camera won't start.
- No signal? GatePass never admits offline; the verdict says "No connection" and nobody is marked in.

## What's stored

Event details, each attendee's name and the one contact column you choose (email or phone), and every scan (time, gate name, a random device id). Deleting an event deletes all of it. Attendees' pass pages show only their name, the event and whether the pass was used.

## Files

```
index.html              organiser app (sign-in, events, passes, gate code, live counter)
p/index.html            the attendee's pass, at p/#<token>
gate/index.html         the gate scanner
firebase-config.js      your Firebase web app config (the only file you edit)
assets/js/firebase.js   Firebase Auth + Firestore data layer (transactions, rules-friendly paths)
assets/js/core.js       shared helpers, formatting, state
assets/js/organiser.js  organiser dashboard
assets/js/gate.js       gate scanner UI
assets/js/pass.js       attendee pass page
assets/js/csv.js        CSV / Google Sheets parsing
assets/js/scanner.js    camera + QR decoding
firestore.rules         who can read/write each collection
firestore.indexes.json  Firestore indexes
SETUP.md                Firebase console setup, step by step
assets/                 css, js modules, fonts, poster art, textures
vendor/                 jsQR, qrcode-generator (see vendor/LICENSES.md)
```

Plain HTML, CSS and JavaScript modules. No build step and nothing to install. To run it locally: `python -m http.server 8000` in the repo folder, then open http://localhost:8000. Firebase Auth needs your site's domain listed under **Authorised domains** (add `localhost` for local testing); Firestore needs no allow-list — the Security Rules travel with the project.

## Licence

MIT. Fonts are SIL OFL; vendored libraries keep their own licences ([vendor/LICENSES.md](vendor/LICENSES.md)).

# GatePass

**Free QR entry passes for college club events.** Upload your registrations sheet and everyone gets their own pass. Running a fest? Group its sub-events under one fest, share a public registration link, and each student gets their pass the moment they sign in with Google. At the gate, any phone becomes the scanner. The first scan of a pass goes green; every scan after that goes red, on every phone at the gate, with the time and gate of the first scan. So a shared screenshot works once.

**Use it:** https://firebase-port.vercel.app/
**Or host your own copy for free** in five steps (below). No build step, no server, no paid plan.

<p>
  <img src="screenshots/organiser.png" alt="Organiser dashboard: event poster, registrations, Generate passes, Checked in counter" width="250">
  <img src="screenshots/pass.png" alt="Attendee pass: gig-poster ticket with a big QR and 'Show this at the gate'" width="250">
  <img src="screenshots/gate-red.png" alt="Gate scanner showing a repeat scan in red: Already scanned" width="250">
</p>

Made by [sampath.exe](https://github.com/sampath0411).

---

## The events homepage

The homepage at `/` is now a Luma-inspired event browser. No account is needed to browse; sign in with Google to create or RSVP.

- **Events** — the feed of public events, newest first. Each card shows a cover, date badge, location, ticket price and a "N going" count (with attendee initials).
- **Calendars** — a month grid with dots and labels on days that have events. Click a day to filter the list below, or use the arrows to change month.
- **Discover** — search across event names, places, descriptions and cover themes, plus category chips for a one-tap filter.
- **Create Event** — pick one of six covers, then set the name, start/end date and time, timezone, location, description, ticket price, approval, capacity and visibility (public or private). Under **Registration fields** you decide what guests fill in when they RSVP: the four presets (full name, email, phone number, college) can be unticked, relabelled or marked required, and you can add your own custom fields. The host sees **Edit event** and **Delete event** on their own event pages; editing reopens the same form with the details filled in.
- **Event detail + RSVP** — open a card for the full description, date, venue and attendee count. **Share** copies the event link (or opens the phone's share sheet). **RSVP** opens a form that collects the event's configured fields (name and email are prefilled from Google sign-in); afterwards a guest sees **Edit my details** and **Cancel RSVP**, along with their approval status and pass link. Private events are link-only: they never show up in the feed, calendar or Discover, but any signed-in guest with the direct link can open and RSVP.
- **Member directory** — on their own event page the host gets a **Members (N)** table with a row per guest, columns for every enabled registration field plus **Status**, Joined, a search box, **Export CSV**, and per-row **Edit**/**Remove** buttons. Pending requests also get **Approve**/**Reject**. The host can update any guest's details; a guest can update only their own.

Events live in `gp_events_v2` and RSVPs in `gp_rsvps/{eventId}/rsvps/{uid}`. Each RSVP stores the guest's answers under `answers` (plus flat name/email/phone/college columns for the presets), and the event doc carries its own `formFields` list; older events fall back to the four default presets. Firestore Security Rules make public events listable by anyone, but RSVPs themselves are readable only by the event owner and the guest who made them — the feed's names and counts come from a separate name-only public projection (`gp_members_public`). A private event can be read only by a signed-in link-holder and never appears in a list query. Approval state (`status`, `passToken`, review stamps) is host-only. Only the signed-in member can **create** an RSVP (under their own uid); after that, either the event owner or that member can **update** or **delete** it (a member may edit their own details or resubmit a rejected request, but cannot approve themselves). Adding `?demo=1` to the homepage fills it with sample cards for UI preview — demo mode never writes to Firestore.

**One site, one event model:** `/organiser/` is the organiser area of this same site (linked from the homepage nav as **Organiser**, and from any event you host via **Passes & gate tools**). It manages the very same `gp_events_v2` events the homepage creates and lists — an event made in the dashboard appears on the homepage, and an event made on the homepage opens in the dashboard with the full toolset: sheet uploads → passes, WhatsApp delivery, Sheet sync, gate code and the live checked-in counter. Events created with the first version of the dashboard (`gp_events`) still open there too, listed under **Earlier events**, with their tools intact. Fests (below) remain a separate grouping for multi-event programmes. `/gate/` (the scanner), `/p/#<token>` (a pass) and `/register/#/register/<eventId>` (fest registration) keep their riso-poster styling.

### Sharing, approval and QR passes

- **Share:** the **Share** button on an event page copies the `#/event/<id>` link (or hands it to the device share sheet). Public events are also listed in the feed, calendar and Discover. A private event is hidden from all three — the long random event ID in the link is the capability, and a guest must be signed in with Google to open it. There is no account-free way to find a private event.
- **Approval:** when **Require Approval** is on, a request is saved as `pending` and the guest sees "Awaiting approval" with no pass. The host reviews it in the Members table's **Status** column and taps **Approve** or **Reject**. An approved guest gets a pass; a rejected guest sees "Request wasn't approved" and can edit their details and resubmit. Firestore Rules reject any guest write to `status`, `passToken` or the review fields on an approval event, so nobody can self-approve. Events without approval issue a pass immediately on RSVP.
- **QR pass:** an approved guest sees **Open my pass** on the event page, linking to the same `/p/#<token>` riso-ticket page used for uploaded-sheet and fest passes. The 32-character token is the document ID and the capability; the public pass document never contains the gate code.
- **Gate code:** every event gets an 8-character gate code when it is created. The host sees it on their event page with **Copy gate link**; gate staff type it at `/gate/`. The first scan of a pass is green on every phone, and every later scan is red with the time and gate of the first scan — including for private events, because the gate reads a code-scoped doc rather than the event itself.

---

## How it works

| Who | What they do | Account? |
|---|---|---|
| **Organiser** | Signs in with Google, creates a fest with sub-events (or a single event), and uploads the registrations CSV (or pastes rows / syncs a published Google Sheet). Gets one pass per row, exports links, shares the full pass image, and watches "Checked in N / total" live. For a fest, one **All registrations** table covers every sub-event, and new sign-ups append to a connected Google Sheet. | Yes |
| **Attendee** | For a fest sub-event, opens the public registration link, signs in with Google, fills in their name and lands straight on their QR pass. Shows the ticket at the gate and can share or download the full pass photo. A screenshot works too, once. | Google sign-in for fest registration; a shared pass link needs no account |
| **Gate staff** | Open `/gate/`, type the event's 8-character gate code, pick a gate name and point the camera at passes. "Find by name" covers dead phones. | No |

GatePass sends no email or messages itself. Each pass row has copy, WhatsApp, photo and email buttons. The email button copies the full pass photo (with that person's name and QR) to your clipboard and opens Gmail — paste it into the message (Ctrl+V, or long-press → Paste) to include the image. On mobile it can share the image directly through your phone's share sheet instead. Browsers cannot attach files through a compose link, so this paste step is necessary.

### WhatsApp delivery

Every row whose contact is a phone number has a WhatsApp button: it opens `wa.me` with that person's pass link already written in — you tap Send in WhatsApp. The Passes panel also has a **WhatsApp delivery** box: **Send next on WhatsApp** opens one chat at a time (one tap per chat, so the browser never blocks it) and ticks each row off for the session, and **Copy all WhatsApp messages** copies every message for pasting by hand. Rows with no phone number are counted there too — use Email or Copy link for those. GatePass never sends a message on its own, uses no paid WhatsApp API, and stores no phone numbers beyond the contact column your sheet already has. Bare 10-digit Indian numbers get the `91` country code automatically.

### Fests and public registration

For a multi-day fest or a club fest with several programmes, open **Your events → Fests → New fest**, then add **Sub-events** under it. Each sub-event gets its own 8-character gate code and its own public **Register link** (`register/#/register/<eventId>`). Share that link with students: they sign in with Google, enter their name (email and phone are optional), and land on their pass immediately. Registration can be opened or closed per sub-event from the fest dashboard. All registrations across the fest appear in one **All registrations** table with a CSV export, a per-person checked-in marker (time and gate, from the gate's claim records), a per-sub-event checked-in count, and the same one-tap **WhatsApp delivery** queue the single-event dashboard has. A fest is optional — the single-event flow (create an event → upload a sheet → generate passes) runs on the same events as the homepage.

A student's public pass document never contains the gate code. The registration descriptor is readable only after Google sign-in and cannot be listed, and the roster write is independently validated against the descriptor's code by the Security Rules. Fest registrations are readable only by the fest owner.

### Google Sheet live sync

Two different things share this name:

- **Single events — read a published sheet (no API key):** tap **Or sync from a Google Sheet** under registrations and paste the sheet link. GatePass reads the sheet as CSV (no API key, no Apps Script — the sheet just has to be shared: File → Share → Publish to web, or Anyone with the link can view). The rows land in the same preview as a file upload: check the name/contact columns, then tap Generate. People already on the list are skipped as duplicates — syncing never wipes existing passes, claims, or check-ins, so late Form responses just add new passes. The last synced link is remembered in that browser only. If the browser blocks the fetch, the error says so and the paste-rows box still works.
- **Fests — append to a private Sheet directly (OAuth):** in the fest dashboard, paste the Sheet URL and tab/range under **Google Sheet**, tap **Save**, then **Connect Google Sheet** and grant the Sheets scope. From then on, every new registration appends a row (timestamp, fest, sub-event, name, email, phone, pass link) straight from the organiser's browser to the Sheet, with no API key, server or Apps Script. The Google Cloud steps are in [`SETUP.md`](SETUP.md#direct-google-sheet-writes-oauth-client-id). **Rows only append while the fest dashboard stays open in that browser** — the connection lives in the page, so a closed tab pauses sync; unsynced rows stay pending in the table and are appended when the dashboard is opened and reconnected.

### Why a screenshot only works once

Every pass has a 32-character random token (192 bits), so links can't be guessed. When a gate scans a pass, Firestore runs a transaction that writes a **claim** to `gp_gates/{code}/claims/{passId}` — and the document ID **is** the pass ID, so there can be exactly one claim per pass. Security Rules independently refuse a second create at that path. If two gates scan the same pass in the same millisecond, only one claim can exist: the other scan gets the first scan's time and gate back and shows red. Repeat attempts are logged under that claim, so the organiser sees "3 repeat scans bounced at the gate". The attendee sees it too: the pass page listens live and flips to a **Checked in** stamp (time and gate) once the stamp lands on the pass document — written by the gate where the deployed rules allow that write, and mirrored from the claim records by the organiser's dashboard for first-version events. The claim, never the stamp, is what blocks a repeat scan.

### Security model

- **Firestore Security Rules** guard every collection. Organisers can only read and change their own data; event data lives in owner-scoped subcollections (`gp_users/{uid}/events`, `gp_events/{eventId}/passes`, and the gate's `roster`/`claims`). The gate code is never stored in a document an attendee can read.
- **Attendees** need no account to view a pass they were given: they read it from `gp_passes/{token}`, where the 32-character token (192 bits) is the document ID and the capability. It returns just that one pass (name, event, check-in time) and never contact details, the gate code or anyone else's pass. Students registering for a fest sub-event sign in with Google first; their registration is written under their own uid, and the fest's registrations collection is owner-only.
- **Gate staff** need no account either. The 8-character gate code is a path segment (`gp_gates/{code}`) acting as the capability — 31⁸ ≈ 850 billion combinations — and Rules only allow reading a gate doc that already exists, so codes can't be enumerated. On first-version events the organiser can replace the code with one tap ("New code") and the old one stops working immediately; homepage events keep the code they were created with (the current Rules only allow a gate doc to be created together with its event, and existing claims can't be re-created under a new code without reopening already-scanned passes). Staff search shows masked contacts only (`an•••@gmail.com`, `•••3210`).
- **Approval state is host-only.** On an approval event, Security Rules reject guest writes to an RSVP's `status`, `passToken` or review fields; a guest may still edit their own details or resubmit a rejected request as `pending`. Only the host's approve action creates the pass, roster row and gate-count increment.
- **One-shot claims** live at `gp_gates/{code}/claims/{passId}`; the document ID makes each claim unique and Security Rules enforce a single create.
- **The gate code is a full capability — guard it.** Anyone who holds the code can read that event's roster: attendee **names, masked contacts, pass tokens and the random device IDs** recorded on scans. Share the code only with gate staff you trust; on first-version events, tap **New code** to revoke it immediately if it leaks.
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

For fest registration and direct Sheet appends you also need a Google **OAuth client ID** (Web application) with your deployed domain as an authorised JavaScript origin, the Google Sheets API enabled, and the ID pasted into `googleOAuthClientId` in [`firebase-config.js`](firebase-config.js). The full walkthrough is in [`SETUP.md`](SETUP.md#direct-google-sheet-writes-oauth-client-id).

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

Event details, each attendee's name and the one contact column you choose (email or phone), and every scan (time, gate name, a random device id). Luma-style events also store the registration fields you configured and each guest's RSVP answers under that event, owner-only; an approval request adds its status, the host's review stamp and, once approved, the pass token. Passes the organiser issues from an uploaded sheet keep their contact list on the owner's private per-event index document (`gp_users/{uid}/createdEvents/{eventId}`), readable only by the owner; the public pass document itself never carries a contact or the gate code. Fest registrations store the student's uid, email/phone and pass link under the fest, owner-only. Deleting an event deletes its event data. Attendees' pass pages show only their name, the event and whether the pass was used.

## Files

```
index.html              events homepage (feed, calendar, discover, create, detail + RSVP)
assets/js/events.js     events homepage routing and rendering
assets/css/luma.css     riso-poster homepage styling (warm paper, blue + pink inks), scoped to body.luma
organiser/index.html    the organiser dashboard, at organiser/
p/index.html            the attendee's pass, at p/#<token>
register/index.html     public Google-signed-in registration, at register/#/register/<eventId>
gate/index.html         the gate scanner
firebase-config.js      your Firebase web app config + Google OAuth client ID (the only file you edit)
assets/js/firebase.js   Firebase Auth + Firestore data layer (transactions, rules-friendly paths)
assets/js/core.js       shared helpers, formatting, state
assets/js/organiser.js  organiser dashboard (fests, registrations table, Sheet sync)
assets/js/register.js   registration form → instant pass
assets/js/sheets.js     Google Identity Services token client + Sheets append
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

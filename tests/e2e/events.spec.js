/**
 * End-to-end proof of the Luma-style events homepage: sign in → create an event
 * with configurable registration fields → it appears in the feed, calendar and
 * discover → an attendee RSVPs through the details modal → the count is 1 → the
 * organiser member table/CSV show the answers and the owner can edit a member
 * → the owner edits the title → the feed shows the new title.
 *
 * Like the other E2E specs, everything is overridden from this file: it starts
 * its own Firestore emulator (port 8083, so it can run alongside the 8080/8081/
 * 8082 specs), serves the static site itself, patches assets/js/firebase.js to
 * connect to the emulator with a per-user mock token, and stubs Auth in memory.
 * No production source file is changed.
 *
 * Run from tests/ (where Playwright is installed):
 *   cd tests
 *   npm run test:e2e
 *   # or: npx playwright test e2e/events.spec.js
 *
 * Set GP_E2E_EVENTS_FIRESTORE_PORT to change the port, or
 * GP_E2E_EVENTS_EMULATOR=0 to reuse an emulator already running on that port.
 */
import { test, expect } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFile, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "../..");
const RULES = path.join(ROOT, "firestore.rules");

const PORT = Number(process.env.GP_E2E_EVENTS_FIRESTORE_PORT || 8083);
const HOST = "127.0.0.1";
const PROJECT = "demo-gatepass-events";
const OWNER = "e2e-events-owner", ATTENDEE = "e2e-events-attendee";
const TITLE = "E2E Luma Night", NEW_TITLE = "E2E Luma Night — Updated";
const PHONE = "9876543210", COLLEGE = "Test College", NEW_PHONE = "1112223333";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

let emulator, server, env, baseUrl, tempConfigDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEmulator(timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`http://${HOST}:${PORT}/`);
      if (r.ok || r.status === 404) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`Firestore emulator did not start on ${HOST}:${PORT}`);
}

function emulatorConfig() {
  tempConfigDir = mkdtempSync(path.join(os.tmpdir(), "gatepass-events-e2e-"));
  const file = path.join(tempConfigDir, "firebase.json");
  writeFileSync(file, JSON.stringify({ emulators: { firestore: { host: HOST, port: PORT } } }, null, 2));
  return file;
}

async function startEmulator() {
  if (process.env.GP_E2E_EVENTS_EMULATOR === "0") {
    await waitForEmulator();
    return;
  }
  emulator = spawn("firebase", [
    "emulators:start", "--only", "firestore",
    "--project", PROJECT, "--config", emulatorConfig(),
  ], { cwd: tempConfigDir, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  emulator.stdout.on("data", (d) => { log += d; });
  emulator.stderr.on("data", (d) => { log += d; });
  emulator.on("error", (e) => { log += `\nspawn error: ${e.message}`; });
  try {
    await waitForEmulator();
  } catch (e) {
    throw new Error(`${e.message}\n--- emulator log ---\n${log.slice(-4000)}`);
  }
}

function stopEmulator() {
  if (!emulator || emulator.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(emulator.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    emulator.kill("SIGTERM");
  }
}

async function startStaticServer() {
  server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
    catch { res.writeHead(400).end(); return; }
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = path.resolve(ROOT, "." + pathname);
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403).end(); return; }
    readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  baseUrl = `http://${HOST}:${server.address().port}`;
}

// A tiny stand-in for firebase/auth: a signed-in user for the chosen uid.
const fakeAuthModule = `
  const user = () => {
    const uid = window.__GP_TEST_UID;
    return uid ? { uid, email: uid + "@example.com", displayName: uid } : null;
  };
  const current = { currentUser: user() };
  export const auth = current;
  export function getAuth() { return current; }
  export class GoogleAuthProvider {}
  export async function signInWithPopup() { current.currentUser = user(); return { user: user() }; }
  export async function signInWithRedirect() {}
  export async function getRedirectResult() { return null; }
  export async function signOut() { current.currentUser = null; }
  export function onAuthStateChanged(_auth, cb) {
    queueMicrotask(() => cb(user()));
    return () => {};
  }
`;

/**
 * Point a browser context at the emulator with a signed-in user:
 *  1. firebase-config.js is fulfilled with the emulator project.
 *  2. firebase/auth is fulfilled with the in-memory signed-in module above.
 *  3. assets/js/firebase.js is fulfilled with a copy that connects to the
 *     emulator with a mock token whose sub is the chosen uid (rules see it).
 */
async function makeContext(browser, uid) {
  const cfg = {
    apiKey: "fake-api-key-for-emulator",
    authDomain: `${PROJECT}.firebaseapp.com`,
    projectId: PROJECT,
    appId: "1:1234567890:web:emulator",
  };
  const context = await browser.newContext({ permissions: [], baseURL: baseUrl });
  await context.addInitScript((args) => {
    window.__GP_TEST_UID = args.uid;
    window.FIREBASE = args.cfg;
  }, { uid, cfg });

  await context.route("**/firebase-config.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: `window.FIREBASE = ${JSON.stringify(cfg)};`,
    }));

  await context.route("**/firebasejs/11.10.0/firebase-auth.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: fakeAuthModule }));

  await context.route("**/assets/js/firebase.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();

    const importPattern = /serverTimestamp,\s*increment,\s*onSnapshot,\s*\} from "firebase\/firestore";/;
    const dbPattern = /export const db = app \? getFirestore\(app\) : null;/;
    const importReplacement = 'serverTimestamp, increment, onSnapshot, connectFirestoreEmulator,\n} from "firebase/firestore";';
    // A uid gives the emulator a mock auth token so rules see that user. With
    // no uid the context is an anonymous gate phone (rules see request.auth ==
    // null), exactly like the duplicate-scan spec.
    const dbExpr = uid
      ? `(() => { const d = getFirestore(app); connectFirestoreEmulator(d, "${HOST}", ${PORT}, { mockUserToken: { sub: ${JSON.stringify(uid)} } }); return d; })()`
      : `(() => { const d = getFirestore(app); connectFirestoreEmulator(d, "${HOST}", ${PORT}); return d; })()`;
    const dbReplacement = `export const db = app ? ${dbExpr} : null;`;

    const haveImport = importPattern.test(body);
    const haveDb = dbPattern.test(body);
    if (!haveImport || !haveDb) {
      throw new Error(
        `Unexpected assets/js/firebase.js shape: import hook found=${haveImport}, db hook found=${haveDb}`
      );
    }
    const patched = body.replace(importPattern, importReplacement).replace(dbPattern, dbReplacement);
    if (importPattern.test(patched) || dbPattern.test(patched) || !patched.includes(dbReplacement)) {
      throw new Error("Emulator hook replacement did not apply cleanly to assets/js/firebase.js");
    }
    await route.fulfill({ response, body: patched, contentType: "text/javascript; charset=utf-8" });
  });
  return context;
}

/** Read the event and its RSVPs with rules disabled (emulator admin). */
async function readEventData(id) {
  let data;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const event = (await db.doc(`gp_events_v2/${id}`).get()).data();
    const rsvps = (await db.collection(`gp_rsvps/${id}/rsvps`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    data = { event, rsvps };
  });
  return data;
}

/** Read a gate doc with rules disabled (emulator admin). */
async function readGateDoc(code) {
  let data;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().doc(`gp_gates/${code}`).get();
    data = snap.data();
  });
  return data;
}

/** The pass capability now lives in its own owner/member-readable doc. */
async function readPassToken(eventId, uid) {
  let token = null;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().doc(`gp_pass_tokens/${eventId}/tokens/${uid}`).get();
    const hasDoc = typeof snap.exists === "function" ? snap.exists() : snap.exists;
    if (hasDoc) token = snap.data().passToken || null;
  });
  return token;
}

/** Read the world-readable, name-only attendee projection (admin view). */
async function readPublicMembers(eventId) {
  let rows;
  await env.withSecurityRulesDisabled(async (ctx) => {
    rows = (await ctx.firestore().collection(`gp_members_public/${eventId}/m`).get()).docs
      .map((d) => ({ uid: d.id, ...d.data() }));
  });
  return rows;
}

/** Verify the document actually exists with rules disabled (reads of missing
 * docs are allowed by some grants, so exists() is the reliable assertion). */
async function existsWithAdmin(path) {
  let exists = false;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().doc(path).get();
    exists = typeof snap.exists === "function" ? snap.exists() : snap.exists;
  });
  return exists;
}

// Gate-phone helpers, mirroring e2e/duplicate-scan.spec.js. The gate is
// unauthenticated (makeContext(browser, null)), so the same join/scan flow
// works for the guest list produced by approval.
async function joinGate(page, code, gateName, expectedCount = "0 / 1") {
  await page.goto("/gate/");
  await expect(page.locator("#joinForm")).toBeVisible();
  await page.locator("#code").fill(code);
  await page.locator(`input[name="gate"][value="${gateName}"]`).check({ force: true });
  await page.locator("#joinBtn").click();
  await expect(page.locator("#scan")).toBeVisible();
  await page.waitForFunction(() => !!window.GatePassGate, null, { timeout: 20000 });
  await expect(page.locator("#cNum")).toHaveText(expectedCount);
}
const scan = (page, url) => page.evaluate((u) => window.GatePassGate.handleText(u), url);

test.describe("Luma events homepage", () => {
  test.setTimeout(240000);

  test.beforeAll(async () => {
    test.setTimeout(180000); // cold emulator starts can exceed the 30s hook default
    await startEmulator();
    await startStaticServer();
    env = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules: readFileSync(RULES, "utf8"), host: HOST, port: PORT },
    });
  });

  test.beforeEach(async () => {
    await env.clearFirestore();
  });

  test.afterAll(async () => {
    if (env) {
      try { await env.clearFirestore(); } catch { /* best effort */ }
      await env.cleanup();
    }
    if (server) await new Promise((r) => server.close(r));
    stopEmulator();
    if (tempConfigDir) rmSync(tempConfigDir, { recursive: true, force: true });
  });

  test("create → feed/calendar/discover → RSVP with details → members/CSV/edit → title edit → feed updates", async ({ browser }) => {
    // ── 1. owner signs in (stubbed Auth) and creates an event through the UI ──
    const owner = await makeContext(browser, OWNER);
    const ownerPage = await owner.newPage();
    await ownerPage.goto("/");
    await expect(ownerPage.locator(".l-h1")).toHaveText("Events");
    await ownerPage.locator('[data-action="create"]').click();
    await expect(ownerPage.locator("#l-create-form")).toBeVisible();
    await expect(ownerPage.locator(".l-user")).toBeVisible(); // signed in
    await ownerPage.locator("#l-title").fill(TITLE);
    await ownerPage.locator("#l-location").fill("Test Hall");
    await ownerPage.locator("#l-desc").fill("An end-to-end test event.");
    await ownerPage.locator('#l-create-form [type="submit"]').click();

    await ownerPage.waitForURL(/#\/event\/[^/]+$/, { timeout: 20000 });
    const id = new URL(ownerPage.url()).hash.replace("#/event/", "");
    expect(id).toMatch(/\w+/);
    await expect(ownerPage.locator(".l-detail-title")).toHaveText(TITLE);
    await expect(ownerPage.locator(".l-rsvp-card")).toContainText("You're hosting this event");

    // ── 2. the new event appears in feed, calendar and discover ──
    await ownerPage.goto("/");
    const cards = ownerPage.locator(".l-card-title");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveText(TITLE);

    await ownerPage.goto("/#/calendar");
    await expect(ownerPage.locator(".l-cal-results")).toContainText(TITLE);

    await ownerPage.goto("/#/discover");
    await expect(ownerPage.locator("#l-discover-results")).toContainText(TITLE);
    await ownerPage.locator("#l-search").fill(TITLE);
    await expect(ownerPage.locator("#l-discover-results .l-card-title")).toHaveCount(1);
    await expect(ownerPage.locator("#l-discover-results .l-card-title")).toHaveText(TITLE);

    // ── 3. an attendee RSVPs via the details modal; the count becomes 1 ──
    const attendee = await makeContext(browser, ATTENDEE);
    const attendeePage = await attendee.newPage();
    await attendeePage.goto(`/#/event/${id}`);
    await expect(attendeePage.locator(".l-detail-title")).toHaveText(TITLE);
    await expect(attendeePage.locator(".l-rsvp-top strong")).toHaveText("0 going");

    // RSVP is no longer one-click: a modal collects the configured fields.
    await attendeePage.locator('[data-action="rsvp"]').click();
    const rsvpForm = attendeePage.locator("#l-rsvp-form");
    await expect(rsvpForm).toBeVisible();
    await expect(attendeePage.locator(".l-modal-title")).toHaveText(TITLE);
    // Name and email are prefilled from the signed-in Google user.
    await expect(attendeePage.locator("#l-rsvp-name")).toHaveValue(ATTENDEE);
    await expect(attendeePage.locator("#l-rsvp-email")).toHaveValue(`${ATTENDEE}@example.com`);
    // Phone and college are enabled but unfilled; the guest must enter them.
    await expect(attendeePage.locator("#l-rsvp-phone")).toHaveValue("");
    await expect(attendeePage.locator("#l-rsvp-college")).toHaveValue("");
    await attendeePage.locator("#l-rsvp-phone").fill(PHONE);
    await attendeePage.locator("#l-rsvp-college").fill(COLLEGE);
    await rsvpForm.locator('[type="submit"]').click();
    await expect(rsvpForm).toHaveCount(0);
    await expect(attendeePage.locator(".l-rsvp-top strong")).toHaveText("1 going");
    await expect(attendeePage.locator('[data-action="cancel-rsvp"]')).toBeVisible();

    // Security: the going count comes from the public projection, not from
    // raw RSVP reads. A signed-in non-owner cannot read another member's RSVP
    // (this checks the emulator rules directly, via the test env).
    const rsvpPath = `gp_rsvps/${id}/rsvps/${ATTENDEE}`;
    await assertSucceeds(env.authenticatedContext(ATTENDEE).firestore().doc(rsvpPath).get());
    const outsider = env.authenticatedContext("e2e-events-outsider").firestore();
    await assertFails(outsider.doc(rsvpPath).get());
    await assertFails(outsider.collection(`gp_rsvps/${id}/rsvps`).get());
    await assertFails(env.unauthenticatedContext().firestore().doc(rsvpPath).get());
    const projected = await readPublicMembers(id);
    expect(projected).toEqual([{ uid: ATTENDEE, name: ATTENDEE }]);

    // The owner sees the same count from a fresh full page load. (The app
    // caches RSVP counts per page session, so a hash-only navigation would
    // show the count from before the attendee RSVP'd.)
    await ownerPage.goto(`/?fresh=owner-count#/event/${id}`);
    await expect(ownerPage.locator(".l-rsvp-top strong")).toHaveText("1 going");

    // ── 3b. organiser member directory: count, table, CSV and edit ──
    const members = ownerPage.locator("#l-members");
    await expect(members).toBeVisible();
    await expect(ownerPage.locator(".l-members-title")).toHaveText("Members (1)");
    const head = ownerPage.locator(".l-member-table thead th");
    await expect(head).toHaveText(["Full name", "Email", "Phone number", "College", "Status", "Joined", "Actions"]);
    const row = ownerPage.locator("#l-member-rows tr");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(ATTENDEE);
    await expect(row).toContainText(`${ATTENDEE}@example.com`);
    await expect(row).toContainText(PHONE);
    await expect(row).toContainText(COLLEGE);
    await expect(row.locator(".l-member-status")).toHaveText("Approved");

    // CSV export carries every configured answer, not just the count.
    const [download] = await Promise.all([
      ownerPage.waitForEvent("download"),
      ownerPage.locator('[data-action="members-csv"]').click(),
    ]);
    const csv = readFileSync(await download.path(), "utf8");
    expect(csv).toContain("Full name,Email,Phone number,College,Status,Joined");
    expect(csv).toContain(ATTENDEE);
    expect(csv).toContain(`${ATTENDEE}@example.com`);
    expect(csv).toContain(PHONE);
    expect(csv).toContain(COLLEGE);

    // The owner edits a member's details via the modal; the table updates.
    await ownerPage.locator('[data-action="member-edit"]').first().click();
    const memberForm = ownerPage.locator("#l-rsvp-form");
    await expect(memberForm).toBeVisible();
    await expect(ownerPage.locator(".l-modal-title")).toHaveText("Edit member");
    await expect(ownerPage.locator("#l-rsvp-phone")).toHaveValue(PHONE);
    await ownerPage.locator("#l-rsvp-phone").fill(NEW_PHONE);
    await memberForm.locator('[type="submit"]').click();
    await expect(memberForm).toHaveCount(0);
    await expect(ownerPage.locator("#l-member-rows tr")).toContainText(NEW_PHONE);

    // ── 4. owner edits the title; the feed reflects the change ──
    await ownerPage.locator('[data-action="edit"]').click();
    await expect(ownerPage.locator("#l-create-form")).toBeVisible();
    await expect(ownerPage.locator("#l-title")).toHaveValue(TITLE);
    await ownerPage.locator("#l-title").fill(NEW_TITLE);
    await ownerPage.locator('#l-create-form [type="submit"]').click();
    await ownerPage.waitForURL(/#\/event\/[^/]+$/, { timeout: 20000 });
    await expect(ownerPage.locator(".l-detail-title")).toHaveText(NEW_TITLE);

    await ownerPage.goto("/");
    await expect(ownerPage.locator(".l-card-title")).toHaveText(NEW_TITLE);
    await expect(ownerPage.locator(".l-card-title")).not.toHaveText(TITLE);

    // ── 5. Firestore holds the event (with fields) + one RSVP with answers ──
    const data = await readEventData(id);
    expect(data.event.ownerId).toBe(OWNER);
    expect(data.event.title).toBe(NEW_TITLE);
    expect(data.event.visibility).toBe("public");
    expect(data.event.formFields.map((f) => f.key)).toEqual(["name", "email", "phone", "college"]);
    expect(data.rsvps).toHaveLength(1);
    // The RSVP doc ID is the attendee uid (the data layer no longer stores a
    // redundant `uid` field); listRsvps() maps it into the member rows too.
    expect(data.rsvps[0].id).toBe(ATTENDEE);
    expect(data.rsvps[0].answers).toEqual({
      name: ATTENDEE,
      email: `${ATTENDEE}@example.com`,
      phone: NEW_PHONE,
      college: COLLEGE,
    });
    expect(data.rsvps[0].phone).toBe(NEW_PHONE);
    expect(data.rsvps[0].college).toBe(COLLEGE);

    await attendee.close();
    await owner.close();
  });

  test("private + approval event: link-only RSVP → pending → approval → QR pass → gate green/red", async ({ browser }) => {
    const TITLE = "E2E Private Approval Night";

    // ── 1. host creates a private event with approval enabled ──
    const owner = await makeContext(browser, OWNER);
    const ownerPage = await owner.newPage();
    await ownerPage.goto("/");
    await ownerPage.locator('[data-action="create"]').click();
    await expect(ownerPage.locator("#l-create-form")).toBeVisible();
    await ownerPage.locator("#l-title").fill(TITLE);
    await ownerPage.locator("#l-location").fill("Test Hall");
    // Both controls are visually hidden (custom switch / segmented radio), so
    // set their checked state directly; onSubmit reads .checked from the form.
    await ownerPage.locator('#l-create-form input[name="approval"]').evaluate((el) => { el.checked = true; });
    await ownerPage.locator('#l-create-form input[name="visibility"][value="private"]').evaluate((el) => { el.checked = true; });
    await ownerPage.locator('#l-create-form [type="submit"]').click();
    await ownerPage.waitForURL(/#\/event\/[^/]+$/, { timeout: 20000 });
    const id = new URL(ownerPage.url()).hash.replace("#/event/", "");
    await expect(ownerPage.locator(".l-detail-title")).toHaveText(TITLE);

    const created = await readEventData(id);
    expect(created.event.visibility).toBe("private");
    expect(created.event.approval).toBe(true);
    const code = created.event.gateCode;
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    // The host sees the gate code on the event page (formatted as XXXX-XXXX).
    await expect(ownerPage.locator(".l-gate-code")).toHaveText(`${code.slice(0, 4)}-${code.slice(4)}`);

    // ── 2. a private event is absent from the feed, even for the host ──
    await ownerPage.goto("/?fresh=owner-feed");
    await expect(ownerPage.locator(".l-card-title")).toHaveCount(0);

    // ── 3. another signed-in user opens the direct link (not in their feed) ──
    const attendee = await makeContext(browser, ATTENDEE);
    const attendeePage = await attendee.newPage();
    await attendeePage.goto("/?fresh=member-feed");
    await expect(attendeePage.locator(".l-card-title")).toHaveCount(0);
    await attendeePage.goto(`/#/event/${id}`);
    await expect(attendeePage.locator(".l-detail-title")).toHaveText(TITLE);
    await expect(attendeePage.locator(".l-rsvp-top strong")).toHaveText("0 going");

    // ── 4. request → pending, with no pass link ──
    await attendeePage.locator('[data-action="rsvp"]').click();
    const rsvpForm = attendeePage.locator("#l-rsvp-form");
    await expect(rsvpForm).toBeVisible();
    await expect(attendeePage.locator(".l-modal-title")).toHaveText(TITLE);
    await attendeePage.locator("#l-rsvp-phone").fill(PHONE);
    await attendeePage.locator("#l-rsvp-college").fill(COLLEGE);
    await rsvpForm.locator('[type="submit"]').click();
    await expect(rsvpForm).toHaveCount(0);
    await expect(attendeePage.locator(".l-status-banner.is-pending")).toContainText("Awaiting approval");
    await expect(attendeePage.locator(".l-pass-link")).toHaveCount(0);
    await expect(attendeePage.locator(".l-rsvp-top strong")).toHaveText("1 going");
    const pending = await readEventData(id);
    expect(pending.rsvps).toHaveLength(1);
    expect(pending.rsvps[0].status).toBe("pending");
    expect(pending.rsvps[0].passToken).toBeUndefined();
    // Pending members still appear in the world-readable name-only projection.
    const pendingPublic = await readPublicMembers(id);
    expect(pendingPublic).toEqual([{ uid: ATTENDEE, name: ATTENDEE }]);
    expect(pendingPublic[0].status).toBeUndefined();

    // ── 5. host approves from the member table ──
    await ownerPage.goto(`/?fresh=owner-detail#/event/${id}`);
    await expect(ownerPage.locator(".l-members-title")).toHaveText("Members (1)");
    const row = ownerPage.locator("#l-member-rows tr");
    await expect(row.locator(".l-member-status")).toHaveText("Pending");
    await expect(row.locator('[data-action="member-approve"]')).toBeVisible();
    await row.locator('[data-action="member-approve"]').click();
    await expect(row.locator(".l-member-status")).toHaveText("Approved");
    const approved = await readEventData(id);
    expect(approved.rsvps[0].status).toBe("approved");
    // The token is no longer stored on the RSVP (an RSVP reader must not get
    // a scan capability); it lives in the owner/member-only token doc.
    expect(approved.rsvps[0].passToken).toBeUndefined();
    const token = await readPassToken(id, ATTENDEE);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    // Approving issued the pass, the public name projection and bumped the
    // gate total. A non-owner cannot read the raw RSVP, but can see the name.
    expect(await readPublicMembers(id)).toEqual([{ uid: ATTENDEE, name: ATTENDEE }]);
    await assertFails(
      env.authenticatedContext("e2e-events-outsider").firestore().doc(`gp_rsvps/${id}/rsvps/${ATTENDEE}`).get());
    const gate = await readGateDoc(code);
    expect(gate.total).toBe(1);

    // ── 6. member sees "Open my pass"; the pass page renders the QR ──
    await attendeePage.goto(`/?fresh=member-approved#/event/${id}`);
    const passLink = attendeePage.locator(".l-pass-link");
    await expect(passLink).toContainText("Open my pass");
    const passHref = await passLink.getAttribute("href");
    expect(passHref).toContain(`/p/#${token}`);
    const passPage = await (await makeContext(browser, null)).newPage();
    await passPage.goto(passHref);
    await expect(passPage.locator(".ticket")).toBeVisible();
    await expect(passPage.locator(".t-name")).toHaveText(ATTENDEE);
    await expect(passPage.locator(".t-qr svg")).toHaveCount(1);

    // ── 7. two unauthenticated gate phones: first scan green, repeat red ──
    const passUrl = `${baseUrl}/p/#${token}`;
    const phone1 = await (await makeContext(browser, null)).newPage();
    const phone2 = await (await makeContext(browser, null)).newPage();
    await joinGate(phone1, code, "Gate 1");
    await joinGate(phone2, code, "Gate 2");

    await scan(phone1, passUrl);
    await expect(phone1.locator("#verdict")).toHaveClass(/\bok\b/);
    await expect(phone1.locator("#verdict")).toContainText("First scan");
    await expect(phone1.locator("#cNum")).toHaveText("1 / 1");

    await scan(phone2, passUrl);
    await expect(phone2.locator("#verdict")).toHaveClass(/\bdup\b/);
    await expect(phone2.locator("#verdict")).toContainText("Already scanned");
    await expect(phone2.locator("#verdict")).toContainText("first scan at Gate 1");
    const scanned = await readGateDoc(code);
    expect(scanned.checked).toBe(1);
    expect(scanned.bounced).toBe(1);

    // ── 8. revoking the member removes the pass; the old QR no longer scans green ──
    ownerPage.once("dialog", (d) => d.accept());
    await ownerPage.locator('[data-action="member-delete"]').click();
    // Check the authoritative state with emulator admin reads: the host page's
    // Firestore socket can be stale by then, so its member table is not the
    // assertion surface here.
    await expect.poll(() => existsWithAdmin(`gp_rsvps/${id}/rsvps/${ATTENDEE}`)).toBe(false);
    expect(await existsWithAdmin(`gp_passes/${token}`)).toBe(false);
    expect(await existsWithAdmin(`gp_pass_tokens/${id}/tokens/${ATTENDEE}`)).toBe(false);
    expect(await existsWithAdmin(`gp_gates/${code}/roster/${ATTENDEE}`)).toBe(false);
    expect(await existsWithAdmin(`gp_members_public/${id}/m/${ATTENDEE}`)).toBe(false);
    const phone3 = await (await makeContext(browser, null)).newPage();
    await joinGate(phone3, code, "Gate 3", "1 / 1");
    await scan(phone3, passUrl);
    await expect(phone3.locator("#verdict")).toHaveClass(/\bwarn\b/);
    await expect(phone3.locator("#verdict")).toContainText("Not on the list");

    await phone3.close();
    await passPage.close();
    await phone1.close();
    await phone2.close();
    await attendee.close();
    await owner.close();
  });
});

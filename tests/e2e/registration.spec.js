/**
 * End-to-end proof of Phase A: public registration → instant pass → organiser
 * registrations table → one live append to the organiser's Google Sheet.
 *
 * Like duplicate-scan.spec.js, this spec overwrites everything from the test:
 * it starts its own Firestore emulator (port 8082, so it can run alongside the
 * duplicate-scan spec's 8081), serves the static site itself, patches
 * assets/js/firebase.js to point at the emulator, and stubs Auth + Google
 * Identity Services in memory. No production source file is changed.
 *
 * Run from tests/ (where Playwright is installed):
 *   cd tests
 *   npm run test:e2e
 *   # or: npx playwright test e2e/registration.spec.js
 *
 * Set GP_E2E_REG_FIRESTORE_PORT to change the port, or GP_E2E_REG_EMULATOR=0
 * to reuse an emulator already running on that port.
 */
import { test, expect } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFile, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "../..");
const RULES = path.join(ROOT, "firestore.rules");

const PORT = Number(process.env.GP_E2E_REG_FIRESTORE_PORT || 8082);
const HOST = "127.0.0.1";
const PROJECT = "demo-gatepass-registration";
const FEST = "e2e-fest", SUBEVENT = "e2e-subevent", GATE_CODE = "FEST2345";
const OWNER = "e2e-owner", STUDENT = "e2e-student";
const FEST_NAME = "E2E Fest", EVENT_NAME = "Tech Talk";
const SHEET_ID = "e2e-sheet-id", SHEET_RANGE = "Registrations";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`;

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
  tempConfigDir = mkdtempSync(path.join(os.tmpdir(), "gatepass-reg-e2e-"));
  const file = path.join(tempConfigDir, "firebase.json");
  writeFileSync(file, JSON.stringify({ emulators: { firestore: { host: HOST, port: PORT } } }, null, 2));
  return file;
}

async function startEmulator() {
  if (process.env.GP_E2E_REG_EMULATOR === "0") {
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

/** Seed a fest, an open sub-event, its gate and the public descriptor. */
async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const startsAt = new Date();
    await db.doc(`gp_users/${OWNER}/fests/${FEST}`).set({ name: FEST_NAME, startsAt });
    await db.doc(`gp_fests/${FEST}`).set({
      ownerId: OWNER, name: FEST_NAME, club: "Test Club", venue: "Main Hall", art: 0,
      startsAt, sheetId: SHEET_URL, sheetRange: SHEET_RANGE, createdAt: startsAt,
    });
    await db.doc(`gp_fests/${FEST}/events/${SUBEVENT}`).set({
      festId: FEST, name: EVENT_NAME, club: "Test Club", venue: "Main Hall", art: 0,
      startsAt, gateCode: GATE_CODE, registrationOpen: true,
      capacity: 0, total: 0, checked: 0, bounced: 0, recent: [], createdAt: startsAt,
    });
    await db.doc(`gp_gates/${GATE_CODE}`).set({
      festId: FEST, eventId: SUBEVENT, name: EVENT_NAME, club: "Test Club",
      venue: "Main Hall", art: 0, startsAt,
      total: 0, checked: 0, bounced: 0, recent: [],
    });
    await db.doc(`gp_reg_public/${SUBEVENT}`).set({
      festId: FEST, name: EVENT_NAME, club: "Test Club", venue: "Main Hall", art: 0,
      startsAt, gateCode: GATE_CODE, registrationOpen: true, capacity: 0, total: 0,
    });
  });
}

// A tiny stand-in for the real firebase/auth module. It gives the page a
// signed-in user for the chosen uid without touching production source.
const fakeAuthModule = `
  const user = () => {
    const uid = window.__GP_TEST_UID;
    return uid ? { uid, email: uid + "@example.com", displayName: uid } : null;
  };
  const current = { currentUser: user() };
  export const auth = current;
  export function getAuth() { return current; }
  export class GoogleAuthProvider {}
  export async function signInWithPopup() { return { user: user() }; }
  export async function signInWithRedirect() {}
  export async function getRedirectResult() { return null; }
  export async function signOut() { current.currentUser = null; }
  export function onAuthStateChanged(_auth, cb) {
    queueMicrotask(() => cb(user()));
    return () => {};
  }
`;

/**
 * Point a browser context at the emulator with a signed-in user.
 *  1. firebase-config.js is fulfilled with the emulator project + a test OAuth ID.
 *  2. firebase/auth is fulfilled with an in-memory signed-in auth module.
 *  3. window.google is stubbed so sheets.connectSheet() gets a token immediately.
 *  4. assets/js/firebase.js is fulfilled with a copy that connects to the emulator.
 */
async function makeContext(browser, uid) {
  const cfg = {
    apiKey: "fake-api-key-for-emulator",
    authDomain: `${PROJECT}.firebaseapp.com`,
    projectId: PROJECT,
    appId: "1:1234567890:web:emulator",
    googleOAuthClientId: "e2e-oauth-client.apps.googleusercontent.com",
  };
  const context = await browser.newContext({ permissions: [], baseURL: baseUrl });
  await context.addInitScript((args) => {
    window.__GP_TEST_UID = args.uid;
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (opts) => {
            // sheets.js replaces client.callback after init, so call the
            // property at request time (as the real GIS client does).
            const client = {
              callback: opts.callback,
              requestAccessToken: () => queueMicrotask(() => client.callback({
                access_token: "e2e-sheet-token", expires_in: 3600,
              })),
            };
            return client;
          },
        },
      },
    };
  }, { uid });

  await context.route("**/firebase-config.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: `window.FIREBASE = ${JSON.stringify(cfg)};`,
    }));

  await context.route("**/firebasejs/11.10.0/firebase-auth.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: fakeAuthModule }));

  // Insurance: even if the window.google stub were missed, never load the real GIS.
  await context.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: "" }));

  await context.route("**/assets/js/firebase.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();

    const importPattern = /serverTimestamp,\s*increment,\s*onSnapshot,\s*\} from "firebase\/firestore";/;
    const dbPattern = /export const db = app \? getFirestore\(app\) : null;/;
    const importReplacement = 'serverTimestamp, increment, onSnapshot, connectFirestoreEmulator,\n} from "firebase/firestore";';
    // mockUserToken gives Firestore a real (emulator-accepted) auth token with
    // the chosen uid; the fake Auth module above only drives the UI state.
    const dbReplacement = `export const db = app ? (() => { const d = getFirestore(app); connectFirestoreEmulator(d, "${HOST}", ${PORT}, { mockUserToken: { sub: ${JSON.stringify(uid)} } }); return d; })() : null;`;

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

test.describe("Phase A registration and live Sheet sync", () => {
  test.setTimeout(240000);

  test.beforeAll(async () => {
    test.setTimeout(180000);
    await startEmulator();
    await startStaticServer();
    env = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules: readFileSync(RULES, "utf8"), host: HOST, port: PORT },
    });
  });

  test.beforeEach(async () => {
    await env.clearFirestore();
    await seed();
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

  test("a student registers, sees their pass, and the organiser's table + Sheet get one row", async ({ browser }) => {
    const sheetCalls = [];

    // ── organiser: open the fest and connect the (stubbed) Google Sheet ──
    const organiser = await makeContext(browser, OWNER);
    const organiserPage = await organiser.newPage();
    await organiserPage.route("**/sheets.googleapis.com/**", async (route) => {
      sheetCalls.push({
        url: route.request().url(),
        method: route.request().method(),
        authorization: route.request().headers()["authorization"],
        values: route.request().postDataJSON()?.values,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ updates: { spreadsheetId: SHEET_ID, updatedRows: 1 } }),
      });
    });
    await organiserPage.goto(`/#/fest/${FEST}`);
    await expect(organiserPage.locator("#festPoster")).toBeVisible();
    await expect(organiserPage.locator("#festSheetUrl")).toHaveValue(SHEET_URL);
    await expect(organiserPage.locator("#festRegsBox")).toContainText("No registrations yet");
    await organiserPage.locator("#connectSheet").click();
    await expect(organiserPage.locator("#festSheetBox")).toContainText("Connected");
    expect(sheetCalls).toHaveLength(0);   // no rows yet, so nothing appended

    // ── student: open the registration link and submit the form ──
    const student = await makeContext(browser, STUDENT);
    const studentPage = await student.newPage();
    await studentPage.goto(`/register/#/register/${SUBEVENT}`);
    await expect(studentPage.locator("#regForm")).toBeVisible();
    await expect(studentPage.locator("#art")).toContainText(EVENT_NAME);
    await studentPage.locator("#fName").fill("Ada Lovelace");
    await studentPage.locator("#fEmail").fill("ada@example.com");
    await studentPage.locator("#fPhone").fill("9876543210");
    await studentPage.locator("#regBtn").click();

    // Lands straight on the pass page.
    await studentPage.waitForURL(/\/p\/#[A-Za-z0-9_-]+$/, { timeout: 20000 });
    await expect(studentPage.locator(".ticket .t-name")).toHaveText("Ada Lovelace");
    await expect(studentPage.locator(".ticket .t-event")).toContainText(EVENT_NAME);
    await expect(studentPage.locator(".ticket .t-stub")).toContainText("Show this at the gate");

    // ── organiser: the live table shows the registration ──
    const row = organiserPage.locator("#festRegsBox tbody tr");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Ada Lovelace");
    await expect(row).toContainText("ada@example.com");
    await expect(row).toContainText("9876543210");

    // ── Sheets: exactly one append with the right values ──
    await expect.poll(() => sheetCalls.length, { timeout: 20000 }).toBe(1);
    const call = sheetCalls[0];
    expect(call.method).toBe("POST");
    expect(call.authorization).toBe("Bearer e2e-sheet-token");
    expect(call.url).toContain(`/v4/spreadsheets/${SHEET_ID}/values/${SHEET_RANGE}:append`);
    const values = call.values[0];
    expect(values).toHaveLength(7);
    expect(values[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);   // created_at
    expect(values[1]).toBe(FEST_NAME);
    expect(values[2]).toBe(EVENT_NAME);
    expect(values[3]).toBe("Ada Lovelace");
    expect(values[4]).toBe("ada@example.com");
    expect(values[5]).toBe("9876543210");
    expect(values[6]).toBe(studentPage.url());          // the pass link

    // The row is marked synced after the append; no second append follows.
    await expect(row).toContainText("Synced");
    await sleep(750);
    expect(sheetCalls).toHaveLength(1);

    await organiser.close();
    await student.close();
  });
});

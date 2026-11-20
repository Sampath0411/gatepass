/**
 * End-to-end proof of GatePass's one-accepted-scan-per-pass guarantee.
 *
 * Two independent (unauthenticated) gate phones join the same gate with different
 * gate names, scan the same pass, and the first scan must go green while every
 * later scan goes red and bumps the `bounced` counter.
 *
 * Everything the app needs to talk to the emulator is overridden from this file:
 * no production source file is touched.
 *
 * Run (from the repo root):
 *   cd tests && npm install && npm install --no-save @playwright/test
 *   npx playwright test e2e/duplicate-scan.spec.js
 *
 * Or, from the repo root, exactly as the plan says:
 *   npx playwright test tests/e2e/duplicate-scan.spec.js
 *
 * The spec starts its own Firestore emulator on GP_E2E_FIRESTORE_PORT (default
 * 8081, deliberately not Task 10's 8080) and serves the static site itself, so
 * it is self-contained. Set GP_E2E_EMULATOR=0 if you already have an emulator
 * running on that port and want to reuse it.
 */
import { test, expect } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { readFile, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "../..");
const RULES = path.join(ROOT, "firestore.rules");
const FIREBASE_JSON = path.join(E2E_DIR, "firebase.json");

const PORT = Number(process.env.GP_E2E_FIRESTORE_PORT || 8081);
const HOST = "127.0.0.1";
const PROJECT = "demo-gatepass-e2e";
const CODE = "E2E4PASS";
const EVENT = "e2e-event";
const TOKEN = "A".repeat(32); // 32 chars is the real token shape; tokenFrom() accepts it
const PASS = "e2e-pass";
const OWNER = "e2e-owner";

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

let emulator, server, env, baseUrl;

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

async function startEmulator() {
  if (process.env.GP_E2E_EMULATOR === "0") {
    await waitForEmulator();
    return;
  }
  emulator = spawn("firebase", [
    "emulators:start", "--only", "firestore",
    "--project", PROJECT, "--config", FIREBASE_JSON,
  ], {
    cwd: E2E_DIR, shell: true, stdio: ["ignore", "pipe", "pipe"],
  });
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

/** Seed an event + exactly one pass with rules disabled (emulator admin). */
async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const startsAt = new Date();
    await db.doc(`gp_users/${OWNER}/events/${EVENT}`).set({ name: "E2E Night", startsAt });
    await db.doc(`gp_events/${EVENT}`).set({
      ownerId: OWNER, gateCode: CODE, name: "E2E Night", club: "Test Club",
      venue: "Test Hall", art: 0, startsAt, total: 1, createdAt: startsAt,
    });
    await db.doc(`gp_gates/${CODE}`).set({
      eventId: EVENT, name: "E2E Night", club: "Test Club", venue: "Test Hall",
      art: 0, startsAt, total: 1, checked: 0, bounced: 0, recent: [],
    });
    await db.doc(`gp_passes/${TOKEN}`).set({
      id: PASS, eventId: EVENT, name: "Ada Lovelace",
      event: { name: "E2E Night", club: "Test Club", startsAt, venue: "Test Hall", art: 0 },
      checkedInAt: null, gate: "",
    });
    await db.doc(`gp_events/${EVENT}/passes/${PASS}`).set({
      name: "Ada Lovelace", contact: "ada@example.com", token: TOKEN,
      createdAt: startsAt, checkedInAt: null, gate: "",
    });
    await db.doc(`gp_gates/${CODE}/roster/${PASS}`).set({
      name: "Ada Lovelace", nameLower: "ada lovelace", hint: "ad•••@example.com",
      token: TOKEN, checkedInAt: null, gate: "",
    });
  });
}

async function readGate() {
  let result;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().doc(`gp_gates/${CODE}`).get();
    result = snap.data();
  });
  return result;
}

/**
 * Point a browser context at the emulator. Two test-only overrides:
 *  1. firebase-config.js is fulfilled with the emulator project instead of the
 *     real one (the real file unconditionally assigns window.FIREBASE).
 *  2. assets/js/firebase.js is fulfilled with a copy that calls
 *     connectFirestoreEmulator() on the db handle. The source on disk is unchanged.
 */
async function makeContext(browser) {
  const cfg = {
    apiKey: "fake-api-key-for-emulator",
    authDomain: `${PROJECT}.firebaseapp.com`,
    projectId: PROJECT,
    appId: "1:1234567890:web:emulator",
  };
  const context = await browser.newContext({ permissions: [], baseURL: baseUrl });
  await context.addInitScript((c) => { window.FIREBASE = c; }, cfg);

  await context.route("**/firebase-config.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: `window.FIREBASE = ${JSON.stringify(cfg)};`,
    }));

  await context.route("**/assets/js/firebase.js", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const original = body;
    body = body.replace(
      /serverTimestamp,\s*increment,\s*onSnapshot,\s*\} from "firebase\/firestore";/,
      'serverTimestamp, increment, onSnapshot, connectFirestoreEmulator,\n} from "firebase/firestore";'
    );
    body = body.replace(
      /export const db = app \? getFirestore\(app\) : null;/,
      `export const db = app ? (() => { const d = getFirestore(app); connectFirestoreEmulator(d, "${HOST}", ${PORT}); return d; })() : null;`
    );
    if (body === original || !body.includes("connectFirestoreEmulator")) {
      throw new Error("Could not inject the Firestore emulator hook into assets/js/firebase.js");
    }
    await route.fulfill({ response, body, contentType: "text/javascript; charset=utf-8" });
  });
  return context;
}

async function joinGate(page, gateName) {
  await page.goto("/gate/");
  await expect(page.locator("#joinForm")).toBeVisible();
  await page.locator("#code").fill(CODE);
  await page.locator(`input[name="gate"][value="${gateName}"]`).check({ force: true });
  await page.locator("#joinBtn").click();
  await expect(page.locator("#scan")).toBeVisible();
  await page.waitForFunction(() => !!window.GatePassGate, null, { timeout: 20000 });
  await expect(page.locator("#cNum")).toHaveText("0 / 1");
}

// handleText() de-dupes the same token seen within 3.5 s on one phone.
const scan = (page, url) => page.evaluate((u) => window.GatePassGate.handleText(u), url);

test.describe("duplicate scan across two gate phones", () => {
  test.setTimeout(240000);

  test.beforeAll(async () => {
    await startEmulator();
    await startStaticServer();
    env = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules: readFileSync(RULES, "utf8"), host: HOST, port: PORT },
    });
    await seed();
  }, 180000);

  test.afterAll(async () => {
    if (env) {
      try { await env.clearFirestore(); } catch { /* best effort */ }
      await env.cleanup();
    }
    if (server) await new Promise((r) => server.close(r));
    stopEmulator();
  });

  test("first scan is green, every repeat is red and increments bounced", async ({ browser }) => {
    const passUrl = `${baseUrl}/p/#${TOKEN}`;
    const phone1 = await (await makeContext(browser)).newPage();
    const phone2 = await (await makeContext(browser)).newPage();

    await joinGate(phone1, "Gate 1");
    await joinGate(phone2, "Gate 2");

    // ── first phone: accepted ──
    await scan(phone1, passUrl);
    const first = phone1.locator("#verdict");
    await expect(first).toHaveClass(/\bok\b/);
    await expect(first).toContainText("First scan");
    await expect(phone1.locator("#cNum")).toHaveText("1 / 1");

    // ── second phone: rejected, citing the first gate ──
    await scan(phone2, passUrl);
    const second = phone2.locator("#verdict");
    await expect(second).toHaveClass(/\bdup\b/);
    await expect(second).toContainText("Already scanned");
    await expect(second).toContainText("first scan at Gate 1");
    await expect(second).toContainText("1 repeat");
    await expect(phone2.locator("#cNum")).toHaveText("1 / 1");

    // ── another repeat on the second phone bumps bounced again ──
    await sleep(3700); // clear handleText's 3.5 s same-token de-dupe window
    await scan(phone2, passUrl);
    await expect(second).toContainText("2 repeats");

    const gate = await readGate();
    expect(gate.checked).toBe(1);
    expect(gate.bounced).toBe(2);
    expect(gate.total).toBe(1);
  });
});

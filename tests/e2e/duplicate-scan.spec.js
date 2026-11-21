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
 * Run from tests/ (where Playwright is installed):
 *   cd tests
 *   npm ci
 *   npx playwright install chromium
 *   npm run test:e2e
 *   # or: npx playwright test e2e/duplicate-scan.spec.js
 *
 * Running `npx playwright test tests/e2e/duplicate-scan.spec.js` from the repo
 * root works only if Playwright is also installed at the repo root; otherwise
 * npx loads a second copy of Playwright and the runner rejects the spec file.
 *
 * The spec starts its own Firestore emulator on GP_E2E_FIRESTORE_PORT (default
 * 8081, deliberately not Task 10's 8080) and serves the static site itself, so
 * it is self-contained. The emulator config is generated at runtime in a temp
 * directory with that port; tests/e2e/firebase.json is the default-8081
 * reference. Set GP_E2E_EMULATOR=0 to reuse an emulator already running on
 * GP_E2E_FIRESTORE_PORT (that port is then used for every connection).
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

const PORT = Number(process.env.GP_E2E_FIRESTORE_PORT || 8081);
const HOST = "127.0.0.1";
const PROJECT = "demo-gatepass-e2e";
const CODE = "E2E4PASS";
const EVENT = "e2e-event";
const TOKEN = "A".repeat(32); // 32 chars is the real token shape; tokenFrom() accepts it
const PASS = "e2e-pass";
const TOKEN2 = "B".repeat(32); // distinct fresh pass used by the concurrent-scan test
const PASS2 = "e2e-pass-2";
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

/** Write a throwaway firebase.json whose Firestore port is the active PORT. */
function emulatorConfig() {
  tempConfigDir = mkdtempSync(path.join(os.tmpdir(), "gatepass-e2e-"));
  const file = path.join(tempConfigDir, "firebase.json");
  writeFileSync(file, JSON.stringify({
    emulators: { firestore: { host: HOST, port: PORT } },
  }, null, 2));
  return file;
}

async function startEmulator() {
  if (process.env.GP_E2E_EMULATOR === "0") {
    // Reuse mode: no config is needed, but every connection still uses PORT.
    await waitForEmulator();
    return;
  }
  emulator = spawn("firebase", [
    "emulators:start", "--only", "firestore",
    "--project", PROJECT, "--config", emulatorConfig(),
  ], {
    cwd: tempConfigDir, shell: true, stdio: ["ignore", "pipe", "pipe"],
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

/** Seed a second, fresh pass on the same gate for the concurrent-scan test. */
async function seedSecondPass() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const startsAt = new Date();
    await db.doc(`gp_passes/${TOKEN2}`).set({
      id: PASS2, eventId: EVENT, name: "Grace Hopper",
      event: { name: "E2E Night", club: "Test Club", startsAt, venue: "Test Hall", art: 0 },
      checkedInAt: null, gate: "",
    });
    await db.doc(`gp_events/${EVENT}/passes/${PASS2}`).set({
      name: "Grace Hopper", contact: "grace@example.com", token: TOKEN2,
      createdAt: startsAt, checkedInAt: null, gate: "",
    });
    await db.doc(`gp_gates/${CODE}/roster/${PASS2}`).set({
      name: "Grace Hopper", nameLower: "grace hopper", hint: "gr•••@example.com",
      token: TOKEN2, checkedInAt: null, gate: "",
    });
    await db.doc(`gp_gates/${CODE}`).update({ total: 2 });
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
    const body = await response.text();

    const importPattern = /serverTimestamp,\s*increment,\s*onSnapshot,\s*\} from "firebase\/firestore";/;
    const dbPattern = /export const db = app \? getFirestore\(app\) : null;/;
    const importReplacement = 'serverTimestamp, increment, onSnapshot, connectFirestoreEmulator,\n} from "firebase/firestore";';
    const dbReplacement = `export const db = app ? (() => { const d = getFirestore(app); connectFirestoreEmulator(d, "${HOST}", ${PORT}); return d; })() : null;`;

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

async function joinGate(page, gateName, expectedCount = "0 / 1") {
  await page.goto("/gate/");
  await expect(page.locator("#joinForm")).toBeVisible();
  await page.locator("#code").fill(CODE);
  await page.locator(`input[name="gate"][value="${gateName}"]`).check({ force: true });
  await page.locator("#joinBtn").click();
  await expect(page.locator("#scan")).toBeVisible();
  await page.waitForFunction(() => !!window.GatePassGate, null, { timeout: 20000 });
  await expect(page.locator("#cNum")).toHaveText(expectedCount);
}

// handleText() de-dupes the same token seen within 3.5 s on one phone.
const scan = (page, url) => page.evaluate((u) => window.GatePassGate.handleText(u), url);

test.describe("duplicate scan across two gate phones", () => {
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
    // Reset per test so a claim/counter left by an earlier run cannot turn a
    // first scan into a duplicate (or skew the gate's checked/bounced counts).
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

  test("two phones scanning the same fresh pass at once: one ok, one dup", async ({ browser }) => {
    await seedSecondPass();
    const passUrl2 = `${baseUrl}/p/#${TOKEN2}`;
    const phone1 = await (await makeContext(browser)).newPage();
    const phone2 = await (await makeContext(browser)).newPage();

    await joinGate(phone1, "Gate 1", "0 / 2");
    await joinGate(phone2, "Gate 2", "0 / 2");

    // No delay: both verdicts race for the single claim doc under that pass ID.
    await Promise.all([scan(phone1, passUrl2), scan(phone2, passUrl2)]);

    const v1 = phone1.locator("#verdict");
    const v2 = phone2.locator("#verdict");
    const class1 = await v1.getAttribute("class");
    const class2 = await v2.getAttribute("class");
    const text1 = await v1.textContent();
    const text2 = await v2.textContent();
    const kind = (c) => (/\bok\b/.test(c) ? "ok" : /\bdup\b/.test(c) ? "dup" : "other");
    const kinds = [kind(class1), kind(class2)];

    // Whichever phone wins, exactly one goes green and exactly one goes red.
    expect(kinds.filter((k) => k === "ok")).toHaveLength(1);
    expect(kinds.filter((k) => k === "dup")).toHaveLength(1);
    expect(kinds[0] === "ok" ? text1 : text2).toContain("First scan");
    expect(kinds[0] === "dup" ? text1 : text2).toContain("Already scanned");

    // One first scan and one bounce landed on the gate doc for that pass.
    const gate = await readGate();
    expect(gate.checked).toBe(1);
    expect(gate.bounced).toBe(1);
    expect(gate.total).toBe(2);
  });
});

import { initializeApp } from "firebase/app";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, limit, writeBatch, runTransaction,
  serverTimestamp, increment, onSnapshot,
} from "firebase/firestore";

const cfg = window.FIREBASE || {};
export const configured = !!(cfg.apiKey && cfg.projectId && cfg.appId);

export const app = configured ? initializeApp(cfg) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;

const COL = "gp_events", PASS_PUB = "gp_passes", GATES = "gp_gates";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) {
    if (b < 248 && out.length < 8) out += ALPHABET[b % 31];
    if (out.length === 8) break;
  }
  return out.length === 8 ? out : newCode();
}
export function newToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const stamp = (v) => v?.toDate?.()?.toISOString?.() || v || null;
export const onAuth = (cb) => onAuthStateChanged(auth, (u) => cb(u || null));

export async function signIn() {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/popup-closed-by-user") {
      await signInWithRedirect(auth, new GoogleAuthProvider());
      return;
    }
    throw e;
  }
}
export const signOutUser = () => signOut(auth);
export const redirectResult = () => getRedirectResult(auth);

export async function listEvents(uid) {
  const snap = await getDocs(collection(db, "gp_users", uid, "events"));
  return snap.docs.map((d) => ({ id: d.id, name: d.data().name, starts_at: stamp(d.data().startsAt) }));
}

export async function getEvent(id) {
  const s = await getDoc(doc(db, COL, id));
  if (!s.exists()) return null;
  const d = s.data();
  return {
    id, name: d.name, club: d.club || "", venue: d.venue || "", art: d.art || 0,
    starts_at: stamp(d.startsAt), gate_code: d.gateCode,
  };
}

export async function createEvent(row) {
  const id = doc(collection(db, COL)).id;
  const code = newCode();
  const batch = writeBatch(db);
  batch.set(doc(db, COL, id), {
    ownerId: auth.currentUser.uid,
    name: row.name, club: row.club, venue: row.venue, art: row.art,
    startsAt: new Date(row.starts_at), gateCode: code, total: 0, createdAt: serverTimestamp(),
  });
  batch.set(doc(db, "gp_users", auth.currentUser.uid, "events", id), {
    name: row.name, startsAt: new Date(row.starts_at),
  });
  batch.set(doc(db, GATES, code), {
    eventId: id,
    name: row.name, club: row.club, venue: row.venue, art: row.art,
    startsAt: new Date(row.starts_at),
    total: 0, checked: 0, bounced: 0, recent: [],
  });
  await batch.commit();
  return id;
}

export async function updateEvent(id, row) {
  const ev = await getDoc(doc(db, COL, id));
  const gateCode = ev.data().gateCode;
  const gate = await getDoc(doc(db, GATES, gateCode));
  const startsAt = new Date(row.starts_at);
  const batch = writeBatch(db);
  batch.update(doc(db, COL, id), {
    name: row.name, club: row.club, venue: row.venue, art: row.art,
    startsAt,
  });
  batch.set(doc(db, "gp_users", auth.currentUser.uid, "events", id), {
    name: row.name, startsAt,
  });
  if (gate.exists()) {
    batch.update(gate.ref, {
      name: row.name, club: row.club, venue: row.venue, art: row.art,
      startsAt,
    });
  }
  await batch.commit();
}

export async function deleteEvent(id) {
  const ev = await getDoc(doc(db, COL, id));
  if (!ev.exists()) return;
  const code = ev.data().gateCode;
  const passes = await getDocs(collection(db, COL, id, "passes"));
  const roster = await getDocs(collection(db, GATES, code, "roster"));
  const claims = await getDocs(collection(db, GATES, code, "claims"));
  const repeatRefs = [];
  for (const c of claims.docs) {
    const reps = await getDocs(collection(db, GATES, code, "claims", c.id, "repeats"));
    repeatRefs.push(...reps.docs.map((d) => d.ref));
  }
  const childRefs = [
    ...passes.docs.map((d) => d.ref),
    ...roster.docs.map((d) => d.ref),
    ...claims.docs.map((d) => d.ref),
    ...repeatRefs,
    ...passes.docs.map((d) => doc(db, PASS_PUB, d.data().token)),
  ];
  const parentRefs = [
    doc(db, COL, id),
    doc(db, "gp_users", auth.currentUser.uid, "events", id),
    doc(db, GATES, code),
  ];
  for (let i = 0; i < childRefs.length; i += 400) {
    const batch = writeBatch(db);
    childRefs.slice(i, i + 400).forEach((r) => batch.delete(r));
    await batch.commit();
  }
  const finalBatch = writeBatch(db);
  parentRefs.forEach((r) => finalBatch.delete(r));
  await finalBatch.commit();
}

export async function getPasses(eventId) {
  const snap = await getDocs(collection(db, COL, eventId, "passes"));
  return snap.docs.map((d) => {
    const p = d.data();
    return {
      id: d.id, name: p.name, contact: p.contact || "", token: p.token,
      created_at: stamp(p.createdAt) || "",
    };
  });
}

export async function generatePasses(eventId, rows, eventSnapshot) {
  // Never persist the gate code in a publicly readable pass document.
  const { gateCode, ...publicEvent } = eventSnapshot;
  for (let i = 0; i < rows.length; i += 160) {
    const batch = writeBatch(db);
    for (const p of rows.slice(i, i + 160)) {
      const passId = doc(collection(db, COL, eventId, "passes")).id;
      const token = newToken();
      batch.set(doc(db, COL, eventId, "passes", passId), {
        name: p.name, contact: p.contact || "", token,
        createdAt: serverTimestamp(), checkedInAt: null, gate: "",
      });
      batch.set(doc(db, PASS_PUB, token), {
        id: passId, eventId, name: p.name, event: publicEvent,
        checkedInAt: null, gate: "",
      });
      batch.set(doc(db, GATES, gateCode, "roster", passId), {
        name: p.name, nameLower: p.name.toLowerCase(),
        hint: mask(p.contact), token, checkedInAt: null, gate: "",
      });
    }
    batch.update(doc(db, COL, eventId), { total: increment(rows.slice(i, i + 160).length) });
    batch.update(doc(db, GATES, gateCode), { total: increment(rows.slice(i, i + 160).length) });
    await batch.commit();
  }
}

function mask(contact = "") {
  if (!contact) return "";
  if (contact.includes("@")) {
    const i = contact.indexOf("@");
    return contact.slice(0, 2) + "•••" + contact.slice(i);
  }
  return "•••" + contact.replace(/\D/g, "").slice(-4);
}

export async function getPassByToken(token) {
  const s = await getDoc(doc(db, PASS_PUB, token));
  if (!s.exists()) return null;
  const p = s.data();
  return {
    name: p.name, event: p.event,
    checked_in_at: stamp(p.checkedInAt), gate: p.gate || "",
  };
}

export async function rotateCode(eventId, oldCode) {
  const evRef = doc(db, COL, eventId);
  // Read the event once up front so we never start a migration against a stale code.
  const ev = await getDoc(evRef);
  if (!ev.exists() || ev.data().gateCode !== oldCode) throw new Error("Code changed");
  const evData = ev.data();
  // Reuse a pending target code on retry: newCode() must only run on the first
  // attempt, otherwise a failed retry would strand claims under a random code.
  const next = evData.pendingCode || newCode();

  // Read the old gate and all of its data while the old gate doc still exists —
  // rules gate these reads on that doc's existence.
  const oldGate = await getDoc(doc(db, GATES, oldCode));
  if (!oldGate.exists()) throw new Error("Old gate doc missing");
  const g = oldGate.data();

  // First attempt: durably record the chosen target code and pre-create its gate
  // doc. Subcollection writes below authorize by looking up a gate doc at the code
  // in the path, so both gate docs must coexist until the final transaction.
  // On a retry the pendingCode/new gate already exist, so this is skipped.
  if (!evData.pendingCode) {
    await runTransaction(db, async (tx) => {
      const fresh = await tx.get(evRef);
      if (!fresh.exists() || fresh.data().gateCode !== oldCode) throw new Error("Code changed");
      tx.update(evRef, { pendingCode: next });
      tx.set(doc(db, GATES, next), {
        eventId, name: g.name, club: g.club || "", venue: g.venue || "", art: g.art || 0,
        startsAt: g.startsAt, total: g.total || 0, checked: g.checked || 0,
        bounced: g.bounced || 0, recent: g.recent || [],
      });
    });
  }

  // COPY ONLY — never delete anything under oldCode. Every write below is a set
  // under next, so an interrupted migration leaves the ACTIVE old gate fully
  // intact and a retry simply overwrites the partially-created new-code docs.
  const roster = await getDocs(collection(db, GATES, oldCode, "roster"));
  const rows = roster.docs.map((d) => ({ id: d.id, data: d.data() }));
  const claimSnap = await getDocs(collection(db, GATES, oldCode, "claims"));
  const claims = [];
  for (const c of claimSnap.docs) {
    const reps = await getDocs(collection(db, GATES, oldCode, "claims", c.id, "repeats"));
    claims.push({
      id: c.id, data: c.data(),
      // Preserve the original repeat IDs so retries overwrite instead of duplicating.
      repeats: reps.docs.map((d) => ({ id: d.id, data: d.data() })),
    });
  }

  for (let i = 0; i < rows.length; i += 240) {
    const batch = writeBatch(db);
    for (const r of rows.slice(i, i + 240)) {
      batch.set(doc(db, GATES, next, "roster", r.id), r.data);
    }
    await batch.commit();
  }

  // Claims and repeats: one claim set plus one set per repeat. Keep a claim's ops
  // together where possible, but cap every batch at 480 total ops and at most 240
  // repeat writes so nothing hits the 500-op limit.
  let batch = writeBatch(db), count = 0, repeats = 0;
  async function flush() {
    if (!count) return;
    await batch.commit();
    batch = writeBatch(db);
    count = 0;
    repeats = 0;
  }
  for (const c of claims) {
    const need = 1 + c.repeats.length;
    if (count && (count + need > 480 || repeats + c.repeats.length > 240)) await flush();
    batch.set(doc(db, GATES, next, "claims", c.id), c.data);
    count++;
    for (const r of c.repeats) {
      if (repeats >= 240) await flush();   // a single oversized claim
      batch.set(doc(db, GATES, next, "claims", c.id, "repeats", r.id), r.data);
      count++;
      repeats++;
    }
  }
  await flush();

  // ONLY NOW, with all data copied, repoint the event and remove the old gate doc.
  // We do NOT delete the old subcollections: once the old gate doc is gone, rules
  // deny those deletes anyway, and the orphaned docs are unreadable and harmless.
  await runTransaction(db, async (tx) => {
    const fresh = await tx.get(evRef);
    if (!fresh.exists() || fresh.data().gateCode !== oldCode) throw new Error("Code changed");
    tx.update(evRef, { gateCode: next, pendingCode: null });
    tx.delete(doc(db, GATES, oldCode));
  });
  return next;
}

export async function joinGate(code) {
  let s;
  try {
    s = await getDoc(doc(db, GATES, code));
  } catch (e) {
    // Rules deny get on a nonexistent gate doc, so an invalid/rotated code
    // surfaces as permission-denied rather than a clean miss.
    if (e.code === "permission-denied") return null;
    throw e;
  }
  if (!s.exists()) return null;
  const d = s.data();
  // Gate staff are unauthenticated: read everything from the gate doc, never gp_events.
  return {
    event_id: d.eventId, name: d.name, club: d.club || "",
    starts_at: stamp(d.startsAt), venue: d.venue || "", art: d.art || 0,
    counts: { total: d.total || 0, checked: d.checked || 0, bounced: d.bounced || 0 },
  };
}

let statsUnsub = null, statsCode = null, lastStats = null;
export function gateStats(code) {
  if (statsUnsub && statsCode === code) return;   // idempotent; scans call this often
  if (statsUnsub) statsUnsub();
  lastStats = null;
  statsUnsub = onSnapshot(doc(db, GATES, code), (s) => {
    if (!s.exists()) return;
    const d = s.data();
    lastStats = {
      counts: { total: d.total || 0, checked: d.checked || 0, bounced: d.bounced || 0 },
      recent: d.recent || [],
    };
    window.dispatchEvent(new CustomEvent("gp-stats", { detail: {
      badCode: false, offline: false, ...lastStats,
    }}));
  }, (e) => {
    // Bad/rotated codes get zeroed counts; transient/offline errors keep the last
    // known counts. Counts/recent are always present so consumers never throw.
    const badCode = e.code === "permission-denied";
    const cached = !badCode && lastStats;
    window.dispatchEvent(new CustomEvent("gp-stats", { detail: {
      badCode, offline: !badCode,
      counts: cached ? lastStats.counts : { total: 0, checked: 0, bounced: 0 },
      recent: cached ? lastStats.recent : [],
    }}));
  });
  statsCode = code;
}

export function stopStats() {
  if (statsUnsub) statsUnsub();
  statsUnsub = null;
  statsCode = null;
}

export async function gateFind(code, text) {
  const q = text.trim().toLowerCase();
  if (q.length < 2) return [];
  let s;
  try {
    s = await getDocs(query(
      collection(db, GATES, code, "roster"),
      where("nameLower", ">=", q), where("nameLower", "<=", q + "\uf8ff"), limit(8)));
  } catch (e) {
    // Rules deny reads under a nonexistent (invalid/rotated) gate code.
    if (e.code === "permission-denied") return [];
    throw e;
  }
  return s.docs.map((d) => {
    const r = d.data();
    return {
      id: d.id, name: r.name, hint: r.hint, token: r.token,
      checked_in_at: stamp(r.checkedInAt), gate: r.gate || "",
    };
  });
}

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
  const next = newCode();
  // Read the roster while the old gate doc still exists — rules gate reads on its existence.
  const roster = await getDocs(collection(db, GATES, oldCode, "roster"));
  const rows = roster.docs.map((d) => ({ id: d.id, data: d.data() }));
  const claimSnap = await getDocs(collection(db, GATES, oldCode, "claims"));
  const claims = [];
  for (const c of claimSnap.docs) {
    const reps = await getDocs(collection(db, GATES, oldCode, "claims", c.id, "repeats"));
    claims.push({ id: c.id, data: c.data(), repeats: reps.docs.map((r) => r.data()) });
  }
  const evRef = doc(db, COL, eventId);

  // ORDER MATTERS. Subcollection writes authorize by looking up a gate doc at the
  // code in the path. Both gate docs must exist while we migrate, so delete the
  // old gate doc LAST — otherwise the migration writes are denied and the claims
  // are lost, which would let every pass be scanned as "first" again.
  await runTransaction(db, async (tx) => {
    const ev = await tx.get(evRef);
    if (!ev.exists() || ev.data().gateCode !== oldCode) throw new Error("Code changed");
    const oldGate = await tx.get(doc(db, GATES, oldCode));
    if (!oldGate.exists()) throw new Error("Old gate doc missing");
    const g = oldGate.data();
    tx.set(doc(db, GATES, next), {
      eventId, total: g.total || 0,
      checked: g.checked || 0, bounced: g.bounced || 0,
      recent: g.recent || [],
      name: g.name, club: g.club || "", venue: g.venue || "", art: g.art || 0,
      startsAt: g.startsAt,
    });
    tx.update(evRef, { gateCode: next });
    // no delete here
  });

  for (let i = 0; i < rows.length; i += 240) {
    const batch = writeBatch(db);
    for (const r of rows.slice(i, i + 240)) {
      batch.set(doc(db, GATES, next, "roster", r.id), r.data);
      batch.delete(doc(db, GATES, oldCode, "roster", r.id));
    }
    await batch.commit();
  }
  for (const c of claims) {
    const batch = writeBatch(db);
    batch.set(doc(db, GATES, next, "claims", c.id), c.data);
    batch.delete(doc(db, GATES, oldCode, "claims", c.id));
    for (const r of c.repeats) batch.set(doc(collection(db, GATES, next, "claims", c.id, "repeats")), r);
    await batch.commit();
  }
  // Now that nothing points at the old code, remove it.
  await deleteDoc(doc(db, GATES, oldCode));
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

let statsUnsub = null, statsCode = null;
export function gateStats(code) {
  if (statsUnsub && statsCode === code) return;   // idempotent; scans call this often
  if (statsUnsub) statsUnsub();
  statsUnsub = onSnapshot(doc(db, GATES, code), (s) => {
    if (!s.exists()) return;
    const d = s.data();
    window.dispatchEvent(new CustomEvent("gp-stats", { detail: {
      counts: { total: d.total || 0, checked: d.checked || 0, bounced: d.bounced || 0 },
      recent: d.recent || [],
    }}));
  }, (e) => {
    // Bad/rotated codes and connectivity errors both need a payload whose shape
    // consumers can read (they access e.detail.counts) without throwing.
    const flag = e.code === "permission-denied" ? "badCode" : "offline";
    window.dispatchEvent(new CustomEvent("gp-stats", { detail: {
      [flag]: true,
      counts: { total: 0, checked: 0, bounced: 0 },
      recent: [],
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

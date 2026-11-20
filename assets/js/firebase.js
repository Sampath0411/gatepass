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

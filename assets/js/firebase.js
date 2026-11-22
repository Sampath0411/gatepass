import { initializeApp } from "firebase/app";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, writeBatch, runTransaction,
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

  // First attempt only: durably record the chosen target code. Both the initial
  // guard and the transaction re-check that we're still on oldCode and that no
  // other rotation has claimed this event with a pendingCode.
  if (evData.gateCode === oldCode && !evData.pendingCode) {
    await runTransaction(db, async (tx) => {
      const fresh = await tx.get(evRef);
      if (!fresh.exists() || fresh.data().gateCode !== oldCode || fresh.data().pendingCode) {
        throw new Error("Code changed");
      }
      tx.update(evRef, { pendingCode: next });
    });
  }

  // Refresh the target gate doc on EVERY attempt. Scans and edits on the old code
  // may have advanced counters/metadata since a failed attempt, so a retry must
  // converge on the current snapshot rather than keeping the first attempt's.
  // Subcollection writes below authorize by looking up a gate doc at the code in
  // the path, so both gate docs must coexist until the final transaction.
  await setDoc(doc(db, GATES, next), {
    eventId, name: g.name, club: g.club || "", venue: g.venue || "", art: g.art || 0,
    startsAt: g.startsAt, total: g.total || 0, checked: g.checked || 0,
    bounced: g.bounced || 0, recent: g.recent || [],
  });

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
  // SECURITY (21 Nov 2026): the token is NEVER returned to the gate UI.
  // Only passId / name / hint / checked status leave this function. Checked
  // status is derived from the one-shot claim doc (the authority), not from
  // the roster stamp — the scan no longer writes that stamp.
  return Promise.all(s.docs.map(async (d) => {
    const r = d.data();
    let checkedInAt = null, gate = "";
    try {
      const claim = await getDoc(doc(db, GATES, code, "claims", d.id));
      if (claim.exists()) {
        checkedInAt = stamp(claim.data().scannedAt);
        gate = claim.data().gate || "";
      }
    } catch {}
    return {
      id: d.id, name: r.name, hint: r.hint,
      checked_in_at: checkedInAt, gate,
    };
  }));
}

export async function scanToken(code, token, gateName, device) {
  const gateRef = doc(db, GATES, code);
  const passRef = doc(db, PASS_PUB, token);

  let gateSnap;
  try {
    gateSnap = await getDoc(gateRef);
  } catch (e) {
    // Rules deny get on a nonexistent/rotated gate doc, so an invalid/rotated
    // code surfaces as permission-denied rather than a clean miss.
    if (e.code === "permission-denied") return { status: "bad_code" };
    throw e;
  }
  if (!gateSnap.exists()) return { status: "bad_code" };
  const passSnap = await getDoc(passRef);
  if (!passSnap.exists()) return { status: "unknown" };
  const pass = passSnap.data();
  if (pass.eventId !== gateSnap.data().eventId) return { status: "wrong_event" };

  // The claim ID is the pass ID. Derive it from the public pass doc we already
  // read so the retry can re-check the same claim outside the transaction.
  const claimRef = doc(db, GATES, code, "claims", pass.id);
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await runTransaction(db, async (tx) => {
        const g = await tx.get(gateRef);
        const p = await tx.get(passRef);
        const existing = await tx.get(claimRef);
        const at = new Date().toISOString();
        const recent = [{ name: p.data().name, passId: p.data().id, gate: gateName, is_first: !existing.exists(), at }];

        if (!existing.exists()) {
          tx.set(claimRef, {
            eventId: g.data().eventId, token, name: p.data().name,
            gate: gateName, device, scannedAt: serverTimestamp(),
          });
          // SECURITY (21 Nov 2026): the scan writes ONLY the claim and the
          // gate counters here. It deliberately does NOT update the pass doc
          // or the roster stamp — those are owner-only in the rules now, so
          // a stamp write would make every unauthenticated scan fail, and
          // the old stamp writes were the fake-check-in hole. The claim is
          // the single authority for "checked in".
          tx.update(gateRef, {
            checked: increment(1),
            recent: [recent[0], ...(g.data().recent || [])].slice(0, 6),
          });
          return { status: "ok", name: p.data().name, scanned_at: at,
            counts: { ...countsOf(g.data()), checked: (g.data().checked || 0) + 1 } };
        }

        tx.set(doc(collection(db, GATES, code, "claims", p.data().id, "repeats")), {
          eventId: g.data().eventId, gate: gateName, device, scannedAt: serverTimestamp(),
        });
        tx.update(gateRef, {
          bounced: increment(1),
          recent: [recent[0], ...(g.data().recent || [])].slice(0, 6),
        });
        // The existing claim was written by a PREVIOUS committed transaction, so its
        // serverTimestamp is already resolved — unlike a claim written in this one.
        // The claim is the only authority for the first scan; the public pass doc
        // is no longer used as a fallback (its stamp is owner-only now).
        const claim = existing.data();
        const firstAt = stamp(claim.scannedAt) || at;
        const firstGate = claim.gate || "";
        const firstDevice = claim.device;
        return {
          status: "dup", name: p.data().name,
          first_at: firstAt, first_gate: firstGate,
          same_device: firstDevice === device && !!device,
          repeats: (g.data().bounced || 0) + 1,
          counts: { ...countsOf(g.data()), bounced: (g.data().bounced || 0) + 1 },
        };
      });
      break;
    } catch (e) {
      // Two phones can read the claim as absent and race to create it. The loser's
      // create is rejected by rules (!exists(claim)) with permission-denied, which
      // the SDK does not auto-retry. If the winner's claim is now visible, re-run
      // the transaction so this scan takes the dup branch.
      if (e.code === "permission-denied" && attempt < 2) {
        const claim = await getDoc(claimRef);
        if (claim.exists()) continue;
      }
      throw e;
    }
  }
  return result;
}

function countsOf(d) {
  return { total: d.total || 0, checked: d.checked || 0, bounced: d.bounced || 0 };
}

export async function admitById(code, passId, gateName, device) {
  // SECURITY (21 Nov 2026): the token is read from the code-scoped roster
  // and used in-memory ONLY for this one scan call — it is never returned,
  // rendered, logged or stored anywhere. Owner-only pass docs are not
  // readable by staff, so the roster is the only place staff can get it;
  // a code-holder calling the API directly can still read it — see the
  // residual-risk note in firestore.rules. A Cloud Function is needed
  // to close that fully.
  let r;
  try {
    r = await getDoc(doc(db, GATES, code, "roster", passId));
  } catch (e) {
    // Rules deny reads under a nonexistent/rotated gate code; surface that as bad_code
    // so the gate UI reacts the same way it does for an invalid gate code. A genuinely
    // missing roster doc for a valid code still returns unknown via the !exists() path.
    if (e.code === "permission-denied") return { status: "bad_code" };
    throw e;
  }
  if (!r.exists()) return { status: "unknown" };
  return scanToken(code, r.data().token, gateName, device);
}

export async function getClaims(code) {
  let snap;
  try {
    snap = await getDocs(collection(db, GATES, code, "claims"));
  } catch (e) {
    // Rules deny reads under a nonexistent/rotated gate code.
    if (e.code === "permission-denied") return [];
    throw e;
  }
  return snap.docs.map((d) => {
    const c = d.data();
    return {
      pass_id: d.id, is_first: true, gate: c.gate || "",
      scanned_at: stamp(c.scannedAt),
    };
  });
}

// ── Phase A: fests, sub-events, public registration ──
export async function listFests(uid) {
  const snap = await getDocs(collection(db, "gp_users", uid, "fests"));
  return snap.docs.map((d) => ({ id: d.id, name: d.data().name, starts_at: stamp(d.data().startsAt) }));
}
export async function getFest(id) {
  const s = await getDoc(doc(db, "gp_fests", id));
  if (!s.exists()) return null;
  const d = s.data();
  return { id, name: d.name, club: d.club || "", venue: d.venue || "", art: d.art || 0,
    starts_at: stamp(d.startsAt), sheetId: d.sheetId || "", sheetRange: d.sheetRange || "Registrations" };
}
export async function createFest(row) {
  const id = doc(collection(db, "gp_fests")).id;
  const batch = writeBatch(db);
  batch.set(doc(db, "gp_fests", id), { ownerId: auth.currentUser.uid, name: row.name,
    club: row.club, venue: row.venue, art: row.art, startsAt: new Date(row.starts_at),
    sheetId: "", sheetRange: "Registrations", createdAt: serverTimestamp() });
  batch.set(doc(db, "gp_users", auth.currentUser.uid, "fests", id), { name: row.name, startsAt: new Date(row.starts_at) });
  await batch.commit();
  return id;
}
export async function setFestSheet(festId, sheetId, sheetRange) {
  await updateDoc(doc(db, "gp_fests", festId), { sheetId, sheetRange });
}
export async function listSubEvents(festId) {
  const snap = await getDocs(collection(db, "gp_fests", festId, "events"));
  return snap.docs.map((d) => { const e = d.data(); return { id: d.id, festId, name: e.name,
    club: e.club || "", venue: e.venue || "", art: e.art || 0, starts_at: stamp(e.startsAt),
    gate_code: e.gateCode, registration_open: !!e.registrationOpen,
    capacity: e.capacity || 0, total: e.total || 0, checked: e.checked || 0 }; });
}
export async function createSubEvent(festId, row) {
  const id = doc(collection(db, "gp_fests", festId, "events")).id;
  const code = newCode();
  const batch = writeBatch(db);
  batch.set(doc(db, "gp_fests", festId, "events", id), { festId, name: row.name, club: row.club,
    venue: row.venue, art: row.art, startsAt: new Date(row.starts_at), gateCode: code,
    registrationOpen: row.registration_open !== false, capacity: row.capacity || 0,
    total: 0, checked: 0, bounced: 0, recent: [], createdAt: serverTimestamp() });
  batch.set(doc(db, "gp_gates", code), { festId, eventId: id, name: row.name, club: row.club,
    venue: row.venue, art: row.art, startsAt: new Date(row.starts_at),
    total: 0, checked: 0, bounced: 0, recent: [] });
  batch.set(doc(db, "gp_reg_public", id), { festId, name: row.name, club: row.club, venue: row.venue,
    art: row.art, startsAt: new Date(row.starts_at), gateCode: code,
    registrationOpen: row.registration_open !== false, capacity: row.capacity || 0, total: 0 });
  await batch.commit();
  return { id, code };
}
export async function setRegistrationOpen(festId, eventId, open) {
  await updateDoc(doc(db, "gp_fests", festId, "events", eventId), { registrationOpen: open });
  await updateDoc(doc(db, "gp_reg_public", eventId), { registrationOpen: open });
}
export async function getRegistrationDescriptor(eventId) {
  const s = await getDoc(doc(db, "gp_reg_public", eventId));
  if (!s.exists()) return null;
  const d = s.data();
  return { event_id: eventId, fest_id: d.festId, name: d.name, club: d.club || "",
    venue: d.venue || "", art: d.art || 0, starts_at: stamp(d.startsAt),
    registration_open: !!d.registrationOpen, capacity: d.capacity || 0, total: d.total || 0,
    gate_code: d.gateCode };
}
export async function registerStudentWithCode(desc, user, fields, code) {
  // Defense in depth: the caller passes the gate code, so re-validate it here
  // against the signed-in-readable descriptor. A stale or tampered code must not
  // be allowed to write a roster entry under a code that belongs to another event.
  const def = await getDoc(doc(db, "gp_reg_public", desc.event_id));
  if (!def.exists() || def.data().gateCode !== code) throw new Error("Invalid registration code");
  // Best-effort duplicate guard. The rules currently allow only the fest owner to
  // list registrations, so a student's query can be denied — in that case skip the
  // check and let the rules' own guard be the authority rather than blocking a
  // legitimate registration.
  try {
    const dup = await getDocs(query(
      collection(db, "gp_fests", desc.fest_id, "registrations"),
      where("uid", "==", user.uid), where("eventId", "==", desc.event_id), limit(1)));
    if (!dup.empty) {
      const e = new Error("You are already registered for this event");
      e.code = "already-registered";
      throw e;
    }
  } catch (e) {
    if (e.code === "already-registered") throw e;
  }
  const eventPath = ["gp_fests", desc.fest_id, "events", desc.event_id];
  const passId = doc(collection(db, ...eventPath, "passes")).id;
  const token = newToken();
  const regRef = doc(collection(db, "gp_fests", desc.fest_id, "registrations"));
  const batch = writeBatch(db);
  batch.set(doc(db, ...eventPath, "passes", passId), { name: fields.name, contact: fields.contact,
    token, uid: user.uid, registrationId: regRef.id, createdAt: serverTimestamp(), checkedInAt: null, gate: "" });
  batch.set(regRef, { eventId: desc.event_id, eventName: desc.name, festId: desc.fest_id,
    name: fields.name, email: fields.email || "", phone: fields.phone || "", uid: user.uid,
    passId, token, createdAt: serverTimestamp(), sheetSynced: false });
  batch.set(doc(db, "gp_passes", token), { id: passId, festId: desc.fest_id, eventId: desc.event_id,
    event: { name: desc.name, club: desc.club, starts_at: desc.starts_at, venue: desc.venue, art: desc.art },
    name: fields.name, checkedInAt: null, gate: "" });
  batch.set(doc(db, "gp_gates", code, "roster", passId), { name: fields.name,
    nameLower: fields.name.toLowerCase(), hint: mask(fields.contact || ""), token,
    checkedInAt: null, gate: "" });
  await batch.commit();
  return { token, passId, registrationId: regRef.id };
}
// Owner-side totals: students cannot update the sub-event or descriptor docs, so
// the organiser dashboard calls this after registrations change. Counting the
// registration docs keeps the display and the capacity check accurate even if a
// write is interrupted.
export async function syncEventTotals(festId, eventId) {
  const snap = await getDocs(query(
    collection(db, "gp_fests", festId, "registrations"), where("eventId", "==", eventId)));
  const total = snap.size;
  const batch = writeBatch(db);
  batch.update(doc(db, "gp_fests", festId, "events", eventId), { total });
  batch.update(doc(db, "gp_reg_public", eventId), { total });
  await batch.commit();
  return total;
}
export async function listRegistrations(festId) {
  const snap = await getDocs(collection(db, "gp_fests", festId, "registrations"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data(), created_at: stamp(d.data().createdAt),
    sheet_synced: !!d.data().sheetSynced }));
}
export async function markSheetSynced(festId, regId) {
  await updateDoc(doc(db, "gp_fests", festId, "registrations", regId), { sheetSynced: true });
}
export function watchRegistrations(festId, cb) {
  return onSnapshot(collection(db, "gp_fests", festId, "registrations"), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data(), created_at: stamp(d.data().createdAt),
      sheet_synced: !!d.data().sheetSynced })));
  });
}

// ── Luma-style events v2 + RSVPs ──
const V2 = "gp_events_v2", RSVPS = "gp_rsvps", RSVP_SUB = "rsvps", CREATED = "createdEvents";

// Preset registration fields. Events may override this list per event; older
// events with no stored list fall back to these.
export const DEFAULT_FORM_FIELDS = [
  { key: "name", label: "Full name", type: "text", required: true, enabled: true },
  { key: "email", label: "Email", type: "email", required: true, enabled: true },
  { key: "phone", label: "Phone number", type: "tel", required: false, enabled: true },
  { key: "college", label: "College", type: "text", required: false, enabled: true },
];

function toTime(v) {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && typeof v.toDate === "function") return v; // already a Timestamp
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Shaping happens here so the UI never has to touch Firestore Timestamp objects.
// `starts_at`/`ends_at` and `name` are kept as aliases for existing UI helpers.
function v2Event(s) {
  const d = s.data();
  const starts = stamp(d.startsAt), ends = stamp(d.endsAt);
  return {
    id: s.id, ownerId: d.ownerId,
    title: d.title || "", name: d.title || "",
    cover: d.cover || "crowd",
    startsAt: starts, endsAt: ends, starts_at: starts, ends_at: ends,
    timezone: d.timezone || "", location: d.location || "",
    description: d.description || "", price: d.price || "Free",
    approval: !!d.approval, capacity: d.capacity || 0,
    visibility: d.visibility === "private" ? "private" : "public",
    createdAt: stamp(d.createdAt),
    formFields: d.formFields || DEFAULT_FORM_FIELDS,
  };
}

export async function createV2Event(row) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Sign in required");
  const id = doc(collection(db, V2)).id;
  const event = {
    ownerId: uid,
    title: row.title || row.name || "",
    cover: row.cover || row.art || "crowd",
    startsAt: toTime(row.startsAt ?? row.starts_at),
    endsAt: toTime(row.endsAt ?? row.ends_at),
    timezone: row.timezone || "",
    location: row.location || "",
    description: row.description || "",
    price: row.price || "Free",
    approval: !!row.approval,
    capacity: Number(row.capacity) || 0,
    visibility: row.visibility === "private" ? "private" : "public",
    createdAt: serverTimestamp(),
    formFields: row.formFields || DEFAULT_FORM_FIELDS,
  };
  const batch = writeBatch(db);
  batch.set(doc(db, V2, id), event);
  // Owner index: the only supported way for an owner to list their private events.
  batch.set(doc(db, "gp_users", uid, CREATED, id), {
    title: event.title, startsAt: event.startsAt, visibility: event.visibility,
  });
  await batch.commit();
  return id;
}

export async function listV2Events() {
  // The where() is mandatory: rules are not filters, so a bare collection
  // query would be denied because private events fail the list rule.
  const snap = await getDocs(query(
    collection(db, V2), where("visibility", "==", "public"), orderBy("startsAt", "desc")));
  return snap.docs.map(v2Event);
}

export async function getV2Event(id) {
  const s = await getDoc(doc(db, V2, id));
  return s.exists() ? v2Event(s) : null;
}

export async function updateV2Event(id, row) {
  const patch = {};
  for (const key of ["title", "cover", "timezone", "location", "description", "price", "visibility"]) {
    if (row[key] !== undefined) patch[key] = row[key];
  }
  if (row.approval !== undefined) patch.approval = !!row.approval;
  if (row.capacity !== undefined) patch.capacity = Number(row.capacity) || 0;
  if (row.formFields !== undefined) patch.formFields = row.formFields || DEFAULT_FORM_FIELDS;
  if (row.startsAt !== undefined || row.starts_at !== undefined) {
    patch.startsAt = toTime(row.startsAt ?? row.starts_at);
  }
  if (row.endsAt !== undefined || row.ends_at !== undefined) {
    patch.endsAt = toTime(row.endsAt ?? row.ends_at);
  }
  if (row.name !== undefined && patch.title === undefined) patch.title = row.name;
  if (row.art !== undefined && patch.cover === undefined) patch.cover = row.art;
  if (!Object.keys(patch).length) return;
  // Event doc only — the owner index is intentionally left untouched.
  await updateDoc(doc(db, V2, id), patch);
}

export async function deleteV2Event(id) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Sign in required");
  // Best effort: the rules only let a user delete their OWN RSVP, so an owner
  // cannot always cascade other attendees' entries. Once the event is gone the
  // orphans are unreadable (the read rule's get() on the event fails).
  try {
    const rsvps = await getDocs(collection(db, RSVPS, id, RSVP_SUB));
    for (let i = 0; i < rsvps.docs.length; i += 400) {
      const batch = writeBatch(db);
      rsvps.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (e) {
    if (e.code !== "permission-denied") throw e;
  }
  const batch = writeBatch(db);
  batch.delete(doc(db, V2, id));
  batch.delete(doc(db, "gp_users", uid, CREATED, id));
  await batch.commit();
}

export async function rsvpEvent(eventId, user, answers = {}) {
  const u = user || auth.currentUser;
  const uid = u?.uid;
  if (!uid) throw new Error("Sign in required");
  await setDoc(doc(db, RSVPS, eventId, RSVP_SUB, uid), {
    name: answers.name ?? u.displayName ?? "",
    email: answers.email ?? u.email ?? "",
    phone: answers.phone ?? "",
    college: answers.college ?? "",
    answers,
    at: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateRsvp(eventId, uid, answers = {}) {
  await updateDoc(doc(db, RSVPS, eventId, RSVP_SUB, uid), {
    name: answers.name ?? "",
    email: answers.email ?? "",
    phone: answers.phone ?? "",
    college: answers.college ?? "",
    answers,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteRsvp(eventId, uid) {
  await deleteDoc(doc(db, RSVPS, eventId, RSVP_SUB, uid));
}

export async function cancelRsvp(eventId, user) {
  const uid = user?.uid || auth.currentUser?.uid;
  if (!uid) throw new Error("Sign in required");
  await deleteRsvp(eventId, uid);
}

export async function listRsvps(eventId) {
  const snap = await getDocs(collection(db, RSVPS, eventId, RSVP_SUB));
  return snap.docs.map((d) => {
    const r = d.data();
    return {
      uid: d.id,
      name: r.name || "", email: r.email || "",
      phone: r.phone || "", college: r.college || "",
      answers: r.answers || {},
      at: stamp(r.at),
      created_at: stamp(r.createdAt),
      updated_at: stamp(r.updatedAt),
    };
  });
}

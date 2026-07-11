#!/usr/bin/env node
/**
 * Firestore rules canary (docs/ESIGN_DESIGN.md §9.2): a rules deploy is NOT
 * done until this is denied. Attempts a BACKDATED event write to a scratch
 * ledger — the forked rules must reject any create whose createdAt is not
 * request.time (serverTimestamp). Run against production or the emulator:
 *
 *   FIREBASE_API_KEY=… FIREBASE_AUTH_DOMAIN=… FIREBASE_PROJECT_ID=… \
 *   CANARY_EMAIL=… CANARY_PASSWORD=… node scripts/check-rules.mjs
 *
 * (Any signed-in account works — the rules are the subject, not the user.
 * For the emulator, set FIRESTORE_EMULATOR_HOST and it signs in anonymously.)
 */

import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, signInWithEmailAndPassword } from "firebase/auth";
import { connectFirestoreEmulator, doc, getFirestore, setDoc, serverTimestamp, Timestamp } from "firebase/firestore";

const cfg = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
};
if (!cfg.projectId) {
  console.error("Set FIREBASE_API_KEY / FIREBASE_AUTH_DOMAIN / FIREBASE_PROJECT_ID.");
  process.exit(2);
}
const app = initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app);
if (process.env.FIRESTORE_EMULATOR_HOST) {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  connectFirestoreEmulator(db, host, Number(port));
  await signInAnonymously(auth);
} else {
  await signInWithEmailAndPassword(auth, process.env.CANARY_EMAIL, process.env.CANARY_PASSWORD);
}

const ledgerId = `canary${Date.now()}`;
const base = { encryptedData: "aGVsbG8=", iv: "AAAAAAAAAAAAAAAA" };
let failed = false;

// 1. A well-formed write with serverTimestamp must be ACCEPTED.
try {
  await setDoc(doc(db, "polls", ledgerId, "events", "ok1"), {
    eventId: "ok1",
    createdAt: serverTimestamp(),
    ...base,
  });
  console.log("✓ serverTimestamp write accepted");
} catch (err) {
  console.error("✗ legitimate write was denied — rules are broken:", err.code);
  failed = true;
}

// 2. A BACKDATED write must be DENIED.
try {
  await setDoc(doc(db, "polls", ledgerId, "events", "bad1"), {
    eventId: "bad1",
    createdAt: Timestamp.fromMillis(1_000_000),
    ...base,
  });
  console.error("✗ BACKDATED write was ACCEPTED — deploy the forked firestore.rules!");
  failed = true;
} catch {
  console.log("✓ backdated write denied");
}

// 3. Extra fields must be DENIED.
try {
  await setDoc(doc(db, "polls", ledgerId, "events", "bad2"), {
    eventId: "bad2",
    createdAt: serverTimestamp(),
    sneaky: true,
    ...base,
  });
  console.error("✗ extra-field write was ACCEPTED — deploy the forked firestore.rules!");
  failed = true;
} catch {
  console.log("✓ extra-field write denied");
}

// 4. Overwriting an existing event must be DENIED.
try {
  await setDoc(doc(db, "polls", ledgerId, "events", "ok1"), {
    eventId: "ok1",
    createdAt: serverTimestamp(),
    ...base,
  });
  console.error("✗ event OVERWRITE was ACCEPTED — immutability is broken!");
  failed = true;
} catch {
  console.log("✓ event overwrite denied (append-only holds)");
}

process.exit(failed ? 1 : 0);

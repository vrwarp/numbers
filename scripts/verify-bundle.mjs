#!/usr/bin/env node
/**
 * Offline verifier for e-sign approval certificates (docs/ESIGN_DESIGN.md
 * §7.1). Standalone on purpose — an INDEPENDENT re-implementation of the
 * verification rules that needs no Firestore, no server, and no app code,
 * so archived records stay checkable years from now:
 *
 *   node scripts/verify-bundle.mjs <verification-bundle.json> <packet.pdf> \
 *        --root-fingerprint <hex ≥32 chars> [--approved-copy <copy.pdf>]
 *
 * The root fingerprint MUST come from an out-of-band source (the church's
 * published value) — never from the bundle itself. Exit 0 = verified.
 * Extract the bundle from a certificate PDF's attachments with any PDF tool
 * (it is embedded as verification-bundle.json).
 *
 * --approved-copy checks a downloaded APPROVED COPY (the packet with the
 * approver's marks stamped on) against the approvedPacketSha256 the binding
 * APPROVE event signed over — the copy's bytes are as tamper-evident as the
 * original's.
 */

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
const { subtle } = webcrypto;

// --- Minimal primitives (mirror src/lib/esign, independently) -----------------

function canonicalStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",") + "}";
}
const b64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const hex = (u8) => Buffer.from(u8).toString("hex");
const sha256Hex = async (bytes) => hex(new Uint8Array(await subtle.digest("SHA-256", bytes)));
const actionHash = async (a) => sha256Hex(new TextEncoder().encode(canonicalStringify(a)));

async function openLedger(keyB64, docs) {
  const key = await subtle.importKey("raw", b64(keyB64), { name: "AES-GCM" }, false, ["decrypt"]);
  const sorted = [...docs].sort((a, b) => a.createdAtMs - b.createdAtMs || (a.eventId < b.eventId ? -1 : 1));
  const events = [];
  const seen = new Set();
  for (const doc of sorted) {
    let envelope;
    try {
      const plain = await subtle.decrypt({ name: "AES-GCM", iv: b64(doc.iv) }, key, b64(doc.encryptedData));
      envelope = JSON.parse(new TextDecoder().decode(plain));
    } catch {
      continue; // junk write — ignored, like the app
    }
    const pub = await subtle.importKey("spki", b64(envelope.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      b64(envelope.signature),
      new TextEncoder().encode(canonicalStringify(envelope.action))
    );
    if (!ok) continue;
    const h = await actionHash(envelope.action);
    if (seen.has(h)) continue;
    seen.add(h);
    events.push({
      eventId: doc.eventId,
      createdAtMs: doc.createdAtMs,
      signerPublicKey: envelope.publicKey,
      action: envelope.action,
      actionHash: h,
    });
  }
  return events;
}

// --- Roster replay (rules of ESIGN_DESIGN §4.3–4.4) ----------------------------

/** Two ATTEST subjects name the same identity (all four bound fields agree). */
function sameSubject(a, b) {
  return a.uid === b.uid && a.email === b.email && a.name === b.name && a.publicKey === b.publicKey;
}

function replayRoster(rosterLedgerId, events) {
  if (events.length === 0) throw new Error("empty roster");
  const g = events[0];
  if (g.action.t !== "GENESIS" || g.action.ledger !== rosterLedgerId || g.signerPublicKey !== g.action.root.publicKey) {
    throw new Error("bad genesis");
  }
  const root = g.action.root;
  const members = [{ ...root, attestedAtMs: g.createdAtMs }];
  const pending = new Map();
  const roles = new Map();
  const memberAt = (pk, t) =>
    members.find((m) => m.publicKey === pk && m.attestedAtMs <= t && (m.revokedAtMs === undefined || m.revokedAtMs > t));
  const rolesAt = (uid, t) =>
    uid === root.uid
      ? ["admin"]
      : (roles.get(uid) ?? []).filter((r) => r.grantedAtMs <= t && (r.revokedAtMs === undefined || r.revokedAtMs > t)).map((r) => r.role);
  const isApproverAt = (uid, t) => rolesAt(uid, t).some((r) => ["approver", "treasurer", "admin"].includes(r));

  for (const e of events.slice(1)) {
    const a = e.action;
    if (a.ledger !== rosterLedgerId) continue;
    if (a.t === "ATTEST") {
      const signer = memberAt(e.signerPublicKey, e.createdAtMs);
      if (!signer || signer.uid === a.subject.uid) continue;
      if (a.subject.uid === root.uid) continue; // root rotates by re-genesis, never a vouch
      if (members.some((m) => m.publicKey === a.subject.publicKey && m.revokedAtMs === undefined)) continue;
      const existing = pending.get(a.subject.publicKey);
      // Pooled vouches must name the same identity for the key — mirrors
      // src/lib/esign/roster.ts (sameSubject). Divergent uid/email/name means
      // the vouchers didn't agree on ownership, so they don't combine.
      if (existing && !sameSubject(existing.subject, a.subject)) continue;
      const entry = existing ?? { subject: a.subject, vouchers: new Set() };
      entry.vouchers.add(signer.uid);
      pending.set(a.subject.publicKey, entry);
      if (entry.vouchers.size >= 2 || isApproverAt(signer.uid, e.createdAtMs)) {
        // Key supersession (§4.5): a newly attested key retires the uid's earlier
        // keys. entry.subject.uid === a.subject.uid here (sameSubject guard).
        for (const m of members) if (m.uid === entry.subject.uid && m.revokedAtMs === undefined) m.revokedAtMs = e.createdAtMs;
        members.push({ ...entry.subject, attestedAtMs: e.createdAtMs });
        pending.delete(a.subject.publicKey);
      }
    } else if (a.t === "GRANT_ROLE" || a.t === "REVOKE_ROLE") {
      // Role management: root key, or an attested executive officer/admin at
      // the event's own time; the admin role itself stays root-only — mirrors
      // src/lib/esign/roster.ts (ROLE_MANAGER_ROLES).
      const isRoot = e.signerPublicKey === root.publicKey;
      const signer = memberAt(e.signerPublicKey, e.createdAtMs);
      const isOfficer =
        !!signer &&
        rolesAt(signer.uid, e.createdAtMs).some((r) => ["secretary", "chairman", "treasurer", "admin"].includes(r));
      if ((!isRoot && !isOfficer) || (a.role === "admin" && !isRoot)) continue;
      if (a.t === "GRANT_ROLE") (roles.get(a.uid) ?? roles.set(a.uid, []).get(a.uid)).push({ role: a.role, grantedAtMs: e.createdAtMs });
      else for (const r of roles.get(a.uid) ?? []) if (r.role === a.role && r.revokedAtMs === undefined) r.revokedAtMs = e.createdAtMs;
    } else if (e.signerPublicKey === root.publicKey) {
      if (a.t === "REVOKE_KEY") for (const m of members) if (m.publicKey === a.publicKey && m.revokedAtMs === undefined) m.revokedAtMs = e.createdAtMs;
    }
  }
  return { root, memberAt, rolesAt, isApproverAt };
}

// --- Claim thread rules (ESIGN_DESIGN §5.3) -------------------------------------

function evaluateClaim({ claimId, ledgerId, ownerUid, roster, events }) {
  const ok = events.filter(
    (e) => e.action.ledger === ledgerId && e.action.claimId === claimId && roster.memberAt(e.signerPublicKey, e.createdAtMs)
  );
  const uidOf = (e) => roster.memberAt(e.signerPublicKey, e.createdAtMs).uid;
  const submits = new Map();
  const decisions = [];
  const withdrawals = [];
  const paids = [];
  for (const e of ok) {
    const a = e.action;
    if (a.t === "SUBMIT") {
      if (uidOf(e) !== ownerUid || a.requestorUid !== uidOf(e)) continue;
      if (a.approverUid === uidOf(e) || !roster.isApproverAt(a.approverUid, e.createdAtMs)) continue;
      const list = submits.get(a.seq) ?? [];
      list.push(e);
      submits.set(a.seq, list);
    } else if (a.t === "APPROVE" || a.t === "REJECT") decisions.push(e);
    else if (a.t === "WITHDRAW" && uidOf(e) === ownerUid) withdrawals.push(e);
    else if (a.t === "MARK_PAID" && rolesOkForPaid(roster, e, uidOf(e))) paids.push(e);
  }
  function rolesOkForPaid(roster, e, uid) {
    return e.action.treasurerUid === uid && roster.rolesAt(uid, e.createdAtMs).some((r) => ["treasurer", "admin"].includes(r));
  }
  const threads = [];
  const maxSeq = Math.max(0, ...submits.keys());
  const closure = (thread, nextSha) => {
    if (thread.state === "rejected" || thread.state === "withdrawn")
      return new Set([thread.decision?.actionHash, ...thread.withdrawals.map((w) => w.actionHash)].filter(Boolean));
    if (thread.state === "disputed") {
      const withdrawn = new Set(thread.withdrawals.map((w) => w.action.submitRef));
      return thread.contested.every((s) => withdrawn.has(s.actionHash))
        ? new Set(thread.withdrawals.map((w) => w.actionHash))
        : null;
    }
    if (thread.state === "approved" && thread.submit && nextSha !== thread.submit.action.packetSha256)
      return thread.decision ? new Set([thread.decision.actionHash]) : null;
    return null;
  };
  for (let seq = 1; seq <= maxSeq; seq++) {
    const prev = threads[threads.length - 1];
    const candidates = (submits.get(seq) ?? []).filter((s) => {
      const refs = s.action.closesRef ?? null;
      if (seq === 1) return refs === null || refs.length === 0;
      if (!prev || prev.seq !== seq - 1) return false;
      const need = closure(prev, s.action.packetSha256);
      if (!need) return false;
      const got = new Set(refs ?? []);
      return got.size === need.size && [...need].every((h) => got.has(h));
    });
    if (candidates.length === 0) break;
    const thread = {
      seq,
      submit: candidates.length === 1 ? candidates[0] : null,
      contested: candidates,
      decision: null,
      withdrawals: [],
      paid: null,
      state: candidates.length === 1 ? "open" : "disputed",
    };
    threads.push(thread);
    const refs = new Set(thread.contested.map((s) => s.actionHash));
    thread.withdrawals = withdrawals.filter((w) => refs.has(w.action.submitRef));
    if (thread.state === "disputed") continue;
    const submit = thread.submit;
    const bound = decisions
      .filter(
        (d) =>
          d.action.submitRef === submit.actionHash &&
          d.action.packetSha256 === submit.action.packetSha256 &&
          uidOf(d) === submit.action.approverUid &&
          d.action.approverUid === uidOf(d) &&
          // A9: an APPROVE binds only while the named approver still holds
          // approver-or-above at decision time (REJECT is exempt — it
          // declines to sign rather than signing).
          (d.action.t !== "APPROVE" || roster.isApproverAt(uidOf(d), d.createdAtMs))
      )
      .sort((x, y) => x.createdAtMs - y.createdAtMs || (x.eventId < y.eventId ? -1 : 1));
    thread.decision = bound[0] ?? null;
    if (thread.decision?.action.t === "APPROVE") {
      thread.state = "approved";
      thread.withdrawals = [];
      const paid = paids
        .filter((p) => p.action.approveRef === thread.decision.actionHash && p.action.packetSha256 === submit.action.packetSha256)
        .sort((x, y) => x.createdAtMs - y.createdAtMs)[0];
      if (paid) {
        thread.paid = paid;
        thread.state = "paid";
      }
    } else if (thread.decision?.action.t === "REJECT") thread.state = "rejected";
    else if (thread.withdrawals.length > 0) thread.state = "withdrawn";
  }
  return threads;
}

// --- Main ------------------------------------------------------------------------

const args = process.argv.slice(2);
const fpIndex = args.indexOf("--root-fingerprint");
if (args.length < 2 || fpIndex === -1 || !args[fpIndex + 1]) {
  console.error("Usage: node scripts/verify-bundle.mjs <bundle.json> <packet.pdf> --root-fingerprint <hex>");
  process.exit(2);
}
const expectedFp = args[fpIndex + 1].toLowerCase().replace(/[^0-9a-f]/g, "");
if (expectedFp.length < 32) {
  console.error("Root fingerprint must be at least 32 hex chars (16 bytes).");
  process.exit(2);
}
const bundle = JSON.parse(readFileSync(args[0], "utf8"));
const packet = readFileSync(args[1]);

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// 1. Root anchor — out-of-band, never the bundle's own claim.
const rootFp = await sha256Hex(b64(bundle.registry.rootPublicKey));
if (!rootFp.startsWith(expectedFp)) fail(`root fingerprint mismatch (bundle root: ${rootFp})`);
console.log(`✓ root anchor matches (${rootFp.slice(0, 16)}…)`);

// 2. Roster.
const rosterEvents = await openLedger(bundle.registry.rosterLedgerKey, bundle.rosterEvents);
const roster = replayRoster(bundle.registry.rosterLedgerId, rosterEvents);
if (roster.root.publicKey !== bundle.registry.rootPublicKey) fail("roster genesis key mismatch");
console.log(`✓ roster verified (${rosterEvents.length} events)`);

// 3. Claim threads.
const claimEvents = await openLedger(bundle.claimLedger.ledgerKey, bundle.claimEvents);
const threads = evaluateClaim({
  claimId: bundle.claimId,
  ledgerId: bundle.claimLedger.ledgerId,
  ownerUid: bundle.ownerUid,
  roster,
  events: claimEvents,
});
if (threads.length === 0) fail("no valid submission thread");

// 4. Packet hash binding.
const packetSha = await sha256Hex(packet);
if (packetSha !== bundle.packetSha256) fail(`packet hash mismatch (file: ${packetSha})`);
const current = [...threads].reverse().find((t) => t.submit && t.submit.action.packetSha256 === packetSha);
if (!current) fail("no thread signs these packet bytes");
if (!["approved", "paid"].includes(current.state)) fail(`thread state is '${current.state}', not approved/paid`);

const submitName = current.submit.action.typedName;
const approveName = current.decision?.action.typedName;
console.log(`✓ packet bytes match SUBMIT seq ${current.seq} (${packetSha.slice(0, 16)}…)`);

// 5. Approved copy (optional): the APPROVE payload may bind a second hash —
// the packet with the approver's marks stamped on. Check a provided file
// against it; the signature over the action covers this hash too.
const approvedSha = current.decision?.action.approvedPacketSha256;
const acIndex = args.indexOf("--approved-copy");
if (acIndex !== -1) {
  if (!args[acIndex + 1]) fail("--approved-copy needs a file argument");
  if (!approvedSha) fail("the binding APPROVE carries no approved-copy hash (pre-feature approval)");
  const copySha = await sha256Hex(readFileSync(args[acIndex + 1]));
  if (copySha !== approvedSha) fail(`approved copy hash mismatch (file: ${copySha})`);
  console.log(`✓ approved copy matches the APPROVE-signed hash (${approvedSha.slice(0, 16)}…)`);
} else if (approvedSha) {
  console.log(`  (approved copy bound: ${approvedSha.slice(0, 16)}… — pass --approved-copy to check a file)`);
}

console.log(`✓ ${current.state.toUpperCase()}: submitted by "${submitName}", approved by "${approveName}"${current.paid ? `, paid (check #${current.paid.action.checkNumber || "—"})` : ""}`);
console.log("VERIFIED");

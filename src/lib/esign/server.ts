/**
 * Server-side e-sign pipeline (docs/ESIGN_DESIGN.md §5.5) — SERVER ONLY.
 *
 * The numbers server has NO Firestore access (keyless firebase-admin), so
 * everything it knows about ledgers arrives as client-reported raw event
 * docs. This module is the gate: it decrypts envelopes with the relayed
 * ledger keys, checks ECDSA signatures, and re-runs the SAME isomorphic
 * reducers the browser uses — mirrors (SignerIdentity, User.role, claim
 * status, SignatureRecord) are written only from events that verify.
 * Residual gap by design: omission (nobody reports an event) — filled by any
 * participant's reconciling view.
 */

import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api";
import { openLedger } from "./envelope";
import { replayRoster, type RosterTimeline } from "./roster";
import { evaluateClaimLedger, type ClaimEvaluation } from "./validity";
import type { ClaimAction, EsignRole, RawLedgerEventDoc, RosterAction, VerifiedEvent } from "./types";
import { ROLE_RANK } from "./types";

export interface RegistryRow {
  id: string;
  rosterLedgerId: string;
  rosterLedgerKey: string;
  rootPublicKey: string;
  rootUserId: string;
  consentVersion: string;
  enabled: boolean;
}

export async function getRegistry(): Promise<RegistryRow | null> {
  return prisma.esignRegistry.findFirst();
}

/** Registry exists — enough for VERIFICATION surfaces (/v, packet,
 *  certificate), which stay available even while the system is switched
 *  off: retention never turns off. */
export async function requireRegistry(): Promise<RegistryRow> {
  const registry = await getRegistry();
  if (!registry) throw new ApiError(404, "E-sign is not set up yet");
  return registry;
}

/** Registry exists AND the admin's master switch is on — required by every
 *  ceremony, queue, and enrollment route (docs/ESIGN_DESIGN.md A5). */
export async function requireEnabledRegistry(): Promise<RegistryRow> {
  const registry = await requireRegistry();
  if (!registry.enabled) throw new ApiError(409, "Electronic signing is turned off");
  return registry;
}

const RAW_DOC_LIMIT = 500;

function checkRawDocs(docs: unknown): RawLedgerEventDoc[] {
  if (!Array.isArray(docs) || docs.length === 0 || docs.length > RAW_DOC_LIMIT) {
    throw new ApiError(400, "Bad event report");
  }
  return docs.map((d) => {
    const doc = d as Partial<RawLedgerEventDoc>;
    if (
      typeof doc.eventId !== "string" ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(doc.eventId) ||
      typeof doc.createdAtMs !== "number" ||
      typeof doc.encryptedData !== "string" ||
      typeof doc.iv !== "string" ||
      doc.encryptedData.length > 200_000
    ) {
      throw new ApiError(400, "Bad event doc");
    }
    return doc as RawLedgerEventDoc;
  });
}

/** Append raw docs to the mirror (create-once per (ledgerId, eventId)). */
async function mirrorRawDocs(ledgerId: string, docs: RawLedgerEventDoc[]): Promise<void> {
  for (const doc of docs) {
    try {
      await prisma.ledgerEventMirror.create({
        data: {
          ledgerId,
          eventId: doc.eventId,
          // Firestore reports live with nanosecond precision → fractional ms;
          // BigInt() throws on fractions, so round. (Found by the emulator
          // e2e — the SQLite mock only ever produced integer timestamps.)
          createdAtMs: BigInt(Math.round(doc.createdAtMs)),
          encryptedData: doc.encryptedData,
          iv: doc.iv,
        },
      });
    } catch (err) {
      // Duplicate report (same ledgerId+eventId) is idempotent success;
      // anything else must NOT be swallowed — a silently dropped event is a
      // silently wrong mirror.
      if ((err as { code?: string })?.code !== "P2002") throw err;
    }
  }
}

export async function mirroredRawDocs(ledgerId: string): Promise<RawLedgerEventDoc[]> {
  const rows = await prisma.ledgerEventMirror.findMany({
    where: { ledgerId },
    orderBy: [{ createdAtMs: "asc" }, { eventId: "asc" }],
  });
  return rows.map((r) => ({
    eventId: r.eventId,
    createdAtMs: Number(r.createdAtMs),
    encryptedData: r.encryptedData,
    iv: r.iv,
  }));
}

/** Stamp the decrypted action kind onto mirror rows once verified. */
async function stampKinds(ledgerId: string, events: VerifiedEvent[]): Promise<void> {
  for (const e of events) {
    await prisma.ledgerEventMirror
      .updateMany({
        where: { ledgerId, eventId: e.eventId, kind: "" },
        data: { kind: (e.action as { t?: string }).t ?? "?", verifiedAt: new Date() },
      })
      .catch(() => {});
  }
}

// --- Roster --------------------------------------------------------------------

export async function rosterTimeline(registry: RegistryRow): Promise<RosterTimeline> {
  const docs = await mirroredRawDocs(registry.rosterLedgerId);
  const { events } = await openLedger(registry.rosterLedgerKey, docs);
  const roster = replayRoster(registry.rosterLedgerId, events as VerifiedEvent<RosterAction>[]);
  if (roster.root.publicKey !== registry.rootPublicKey) {
    throw new ApiError(409, "Roster genesis does not match the registered root key");
  }
  return roster;
}

/**
 * Accept reported roster events, verify, and resync the SignerIdentity /
 * User.role mirrors from the full replay. Returns the replay for the caller.
 */
export async function reportRosterEvents(
  registry: RegistryRow,
  rawDocs: unknown
): Promise<RosterTimeline> {
  const docs = checkRawDocs(rawDocs);
  await mirrorRawDocs(registry.rosterLedgerId, docs);
  const allDocs = await mirroredRawDocs(registry.rosterLedgerId);
  const { events } = await openLedger(registry.rosterLedgerKey, allDocs);
  await stampKinds(registry.rosterLedgerId, events);
  const roster = replayRoster(registry.rosterLedgerId, events as VerifiedEvent<RosterAction>[]);
  if (roster.root.publicKey !== registry.rootPublicKey) {
    throw new ApiError(409, "Roster genesis does not match the registered root key");
  }
  await syncRosterMirrors(roster);
  return roster;
}

async function syncRosterMirrors(roster: RosterTimeline): Promise<void> {
  const now = Date.now();
  const identities = await prisma.signerIdentity.findMany();
  for (const identity of identities) {
    // Judge the identity row by its DECLARED key, never by uid alone: a
    // member mid-re-enrollment (start-over) has already declared a NEW
    // pending key while the roster still attests their OLD one — a
    // uid-keyed sync would clobber the re-enrollment back to the old key
    // (found by the emulator e2e; supersession retires the old key only
    // once the new one is vouched, §4.5/A7).
    const entries = roster.members.filter((m) => m.publicKey === identity.publicKey);
    const active = entries.find(
      (m) => m.revokedAtMs === undefined || m.revokedAtMs > now
    );
    if (active) {
      await prisma.signerIdentity.update({
        where: { id: identity.id },
        data: {
          status: "attested",
          attestedAt: new Date(active.attestedAtMs),
        },
      });
    } else if (entries.length > 0 && identity.status !== "revoked") {
      // The declared key WAS on the roster and is now revoked/superseded.
      await prisma.signerIdentity.update({
        where: { id: identity.id },
        data: { status: "revoked" },
      });
    }
    // A key the roster has never seen stays as-is (pending enrollment).
    // Role mirror: highest active roster role (root stays admin).
    const roles = roster.rolesAt(identity.userId, now);
    const highest = roles.sort((a, b) => (ROLE_RANK[b] ?? 0) - (ROLE_RANK[a] ?? 0))[0] as
      | EsignRole
      | undefined;
    await prisma.user
      .update({ where: { id: identity.userId }, data: { role: highest ?? "member" } })
      .catch(() => {});
  }
}

// --- Claim ledgers ---------------------------------------------------------------

export interface ClaimLedgerContext {
  ledgerId: string;
  ledgerKey: string;
  ownerUid: string;
  claimId: string;
}

export async function claimEvaluation(
  registry: RegistryRow,
  ctx: ClaimLedgerContext
): Promise<{ roster: RosterTimeline; evaluation: ClaimEvaluation; events: VerifiedEvent<ClaimAction>[] }> {
  const roster = await rosterTimeline(registry);
  const docs = await mirroredRawDocs(ctx.ledgerId);
  const { events } = await openLedger(ctx.ledgerKey, docs);
  const evaluation = evaluateClaimLedger({
    claimId: ctx.claimId,
    ledgerId: ctx.ledgerId,
    ownerUid: ctx.ownerUid,
    roster,
    events: events as VerifiedEvent<ClaimAction>[],
  });
  return { roster, evaluation, events: events as VerifiedEvent<ClaimAction>[] };
}

/**
 * Verify one reported ceremony event doc against the claim ledger key and
 * return the verified event. Throws 409 when the envelope doesn't verify —
 * the mirror never believes an unverified report.
 */
export async function verifyReportedClaimEvent(
  ctx: ClaimLedgerContext,
  rawDoc: unknown
): Promise<VerifiedEvent<ClaimAction>> {
  const [doc] = checkRawDocs([rawDoc]);
  await mirrorRawDocs(ctx.ledgerId, [doc]);
  const { events, rejected } = await openLedger(ctx.ledgerKey, [doc]);
  if (events.length !== 1) {
    throw new ApiError(409, `Reported event does not verify: ${rejected[0]?.reason ?? "unknown"}`);
  }
  await stampKinds(ctx.ledgerId, events);
  return events[0] as VerifiedEvent<ClaimAction>;
}

/** Record a verified ceremony event; idempotent on action hash. */
export async function recordSignature(
  claimId: string,
  signerUserId: string,
  event: VerifiedEvent<ClaimAction>
): Promise<void> {
  const a = event.action as { t: string; typedName?: string; packetSha256?: string };
  await prisma.signatureRecord
    .create({
      data: {
        reimbursementId: claimId,
        kind: a.t.toLowerCase().replace("mark_", ""),
        signerUserId,
        signerPublicKey: event.signerPublicKey,
        typedName: a.typedName ?? "",
        packetSha256: a.packetSha256 ?? "",
        payloadJson: JSON.stringify(event.action),
        actionHash: event.actionHash,
        ledgerEventId: event.eventId,
      },
    })
    .catch(() => {}); // duplicate report — idempotent
}

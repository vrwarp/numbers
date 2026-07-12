import { beforeAll, describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { deriveApprovedPacket, formatApprovalDate, pngFromDataUrl } from "@/lib/esign/approved-packet";
import { generateClaimPdf, signatureAnchor } from "@/lib/pdf/generate";
import { actionHash } from "@/lib/esign/canonical";
import { replayRoster, type RosterTimeline } from "@/lib/esign/roster";
import { evaluateClaimLedger } from "@/lib/esign/validity";
import type {
  ApproveAction,
  ClaimAction,
  RosterAction,
  SubmitAction,
  VerifiedEvent,
} from "@/lib/esign/types";
import type { SignaturePlacement } from "@/lib/esign/placement";

let templateBytes: Uint8Array;
let anchor: SignaturePlacement;

beforeAll(async () => {
  templateBytes = new Uint8Array(
    await fs.readFile(path.join(process.cwd(), "assets", "cfcc-form-template.pdf"))
  );
  anchor = await signatureAnchor(templateBytes, "approver");
});

// A tiny valid PNG (1×1, opaque) for the ink stamp.
const INK_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function fakePacket(itemCount: number): Promise<Uint8Array> {
  return generateClaimPdf({
    requesterName: "Alice Requestor",
    requesterAddress: "1 Main St, Hayward CA",
    dateString: "07/01/2026",
    items: Array.from({ length: itemCount }, (_, i) => ({
      description: `Item ${i + 1}`,
      amountCents: 1000 + i,
      ministry: "General Fund",
    })),
    receipts: [],
    templateBytes,
  });
}

describe("deriveApprovedPacket", () => {
  it("returns bytes whose sha256 matches, preserves pages, and changes content", async () => {
    const packet = await fakePacket(2);
    const derived = await deriveApprovedPacket({
      packetBytes: packet,
      derivedFromSha256: "a".repeat(64),
      activeRowCount: 2,
      marks: {
        typedName: "Shirley Che",
        dateString: formatApprovalDate(Date.UTC(2026, 6, 12)),
        signaturePng: pngFromDataUrl(INK_PNG_DATA_URL),
        placement: anchor,
      },
    });
    const { sha256Hex } = await import("@/lib/esign/canonical");
    expect(derived.sha256).toBe(await sha256Hex(derived.bytes));
    expect(derived.bytes.length).toBeGreaterThan(packet.length * 0.5);
    expect(Buffer.from(derived.bytes).equals(Buffer.from(packet))).toBe(false);
    const doc = await PDFDocument.load(derived.bytes);
    const original = await PDFDocument.load(packet);
    expect(doc.getPageCount()).toBe(original.getPageCount());
  });

  it("derives without an ink image (typed name + date only) and spans multi-page forms", async () => {
    const packet = await fakePacket(14); // 13 rows/page → 2 form pages
    const derived = await deriveApprovedPacket({
      packetBytes: packet,
      derivedFromSha256: "b".repeat(64),
      activeRowCount: 14,
      marks: {
        typedName: "王姊妹", // exercises the CJK fallback path
        dateString: "07/12/2026",
        signaturePng: null,
        placement: anchor,
      },
    });
    expect((await PDFDocument.load(derived.bytes)).getPageCount()).toBe(2);
  });

  it("pngFromDataUrl accepts only PNG data URLs", () => {
    expect(pngFromDataUrl(INK_PNG_DATA_URL)).toBeInstanceOf(Uint8Array);
    expect(pngFromDataUrl("data:image/jpeg;base64,AAAA")).toBeNull();
    expect(pngFromDataUrl("")).toBeNull();
    expect(pngFromDataUrl(null)).toBeNull();
  });
});

// --- approvedPacketSha256 rides inside the signed action ----------------------

let nextT = 1000;
let nextId = 0;
async function ev<A extends RosterAction | ClaimAction>(
  signerPublicKey: string,
  action: A
): Promise<VerifiedEvent<A>> {
  nextT += 1000;
  return {
    eventId: `e${nextId++}`,
    createdAtMs: nextT,
    signerPublicKey,
    action,
    actionHash: await actionHash(action),
  };
}

const ROSTER = "roster-ap";
const rootPK = "PK_root";
const alicePK = "PK_alice";
const bobPK = "PK_bob";
const carolPK = "PK_carol";

async function miniRoster(): Promise<RosterTimeline> {
  const attest = (uid: string, publicKey: string): RosterAction => ({
    t: "ATTEST",
    v: 1,
    ledger: ROSTER,
    ts: 1,
    subject: { uid, email: `${uid}@x`, name: uid, publicKey },
  });
  const events = [
    await ev(rootPK, {
      t: "GENESIS",
      v: 1,
      ledger: ROSTER,
      ts: 1,
      root: { uid: "root", email: "root@x", name: "Root", publicKey: rootPK },
    } as RosterAction),
    await ev(rootPK, attest("alice", alicePK)),
    await ev(rootPK, attest("bob", bobPK)),
    await ev(rootPK, attest("carol", carolPK)),
    await ev(rootPK, { t: "GRANT_ROLE", v: 1, ledger: ROSTER, ts: 1, uid: "bob", role: "approver" } as RosterAction),
    await ev(rootPK, { t: "GRANT_ROLE", v: 1, ledger: ROSTER, ts: 1, uid: "carol", role: "treasurer" } as RosterAction),
  ];
  return replayRoster(ROSTER, events as VerifiedEvent<RosterAction>[]);
}

describe("approvedPacketSha256 binding", () => {
  const LEDGER = "ledger-ap";
  const CLAIM = "claim-ap";
  const submitAction: SubmitAction = {
    t: "SUBMIT",
    v: 1,
    ledger: LEDGER,
    ts: 1,
    seq: 1,
    closesRef: null,
    claimId: CLAIM,
    packetSha256: "sha-original",
    rowsDigest: "rows",
    totalCents: 8567,
    requestorUid: "alice",
    approverUid: "bob",
    typedName: "Alice",
    consentVersion: "ueta-v1",
    consentSha256: "c",
  };

  it("changes the action hash — the approver's signature covers the copy's bytes", async () => {
    const base: ApproveAction = {
      t: "APPROVE",
      v: 1,
      ledger: LEDGER,
      ts: 1,
      claimId: CLAIM,
      packetSha256: "sha-original",
      submitRef: "r",
      approverUid: "bob",
      typedName: "Bob",
      consentVersion: "ueta-v1",
      consentSha256: "c",
      comment: "",
    };
    const bound = { ...base, approvedPacketSha256: "sha-approved-copy" };
    expect(await actionHash(bound)).not.toBe(await actionHash(base));
  });

  it("threads bind normally with the field present, and MARK_PAID pins it via approveRef", async () => {
    const roster = await miniRoster();
    const sub = await ev(alicePK, submitAction);
    const app = await ev(bobPK, {
      t: "APPROVE",
      v: 1,
      ledger: LEDGER,
      ts: 1,
      claimId: CLAIM,
      packetSha256: "sha-original",
      submitRef: sub.actionHash,
      approverUid: "bob",
      typedName: "Bob",
      consentVersion: "ueta-v1",
      consentSha256: "c",
      comment: "",
      approvedPacketSha256: "sha-approved-copy",
    } as ApproveAction);
    const pay = await ev(carolPK, {
      t: "MARK_PAID",
      v: 1,
      ledger: LEDGER,
      ts: 1,
      claimId: CLAIM,
      packetSha256: "sha-original",
      approveRef: app.actionHash,
      treasurerUid: "carol",
      typedName: "Carol",
      consentVersion: "ueta-v1",
      consentSha256: "c",
      checkNumber: "1042",
    } as ClaimAction);
    const evaluation = evaluateClaimLedger({
      claimId: CLAIM,
      ledgerId: LEDGER,
      ownerUid: "alice",
      roster,
      events: [sub, app, pay] as VerifiedEvent<ClaimAction>[],
    });
    expect(evaluation.threads).toHaveLength(1);
    expect(evaluation.threads[0].state).toBe("paid");
    const decision = evaluation.threads[0].decision!.action as ApproveAction;
    expect(decision.approvedPacketSha256).toBe("sha-approved-copy");
    // approveRef = hash over the APPROVE including the copy's hash — the
    // treasurer's signature pins tier 3 transitively.
    expect((pay.action as { approveRef: string }).approveRef).toBe(app.actionHash);
  });
});

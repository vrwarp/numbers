import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshTestDb, removeTestDb } from "./db";

/**
 * DB-backed coverage of the two cross-tenant READ grants — the privacy
 * boundary beside hard invariant 2:
 *  - the role-read grant (src/lib/roles.ts): verified `User.role` mirror,
 *    narrowed per-duty by the A10 pauses;
 *  - the team read grant (src/lib/teams-catalog.ts): live membership over
 *    budget-category codes, non-draft claims only, per-receipt grain.
 */

const { dir } = freshTestDb("grants");

type Prisma = typeof import("@/lib/prisma")["prisma"];
let prisma: Prisma;
let roles: typeof import("@/lib/roles");
let teams: typeof import("@/lib/teams-catalog");

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  roles = await import("@/lib/roles");
  teams = await import("@/lib/teams-catalog");
});

afterAll(async () => {
  await prisma.$disconnect();
  removeTestDb(dir);
});

async function user(email: string, data: Record<string, unknown> = {}) {
  return prisma.user.create({ data: { email, ...data } });
}

describe("role-read grant (searchCapabilitiesFor)", () => {
  it("plain members have no grant; unknown users have none", async () => {
    const member = await user("member@example.com");
    expect(await roles.searchCapabilitiesFor(member.id)).toEqual({
      canAll: false,
      canDecided: false,
      canTeam: false,
    });
    expect(await roles.searchCapabilitiesFor("no-such-user")).toEqual({
      canAll: false,
      canDecided: false,
      canTeam: false,
    });
    expect(await roles.hasRoleReadGrant(member.id)).toBe(false);
  });

  it("approver gets canAll+canDecided; pausing approvals removes both", async () => {
    const approver = await user("approver@example.com", { role: "approver" });
    let caps = await roles.searchCapabilitiesFor(approver.id);
    expect(caps.canAll).toBe(true);
    expect(caps.canDecided).toBe(true);

    await prisma.user.update({ where: { id: approver.id }, data: { approvalsPaused: true } });
    caps = await roles.searchCapabilitiesFor(approver.id);
    // An approver's ONLY duty is approvals — fully paused reads like a member.
    expect(caps.canAll).toBe(false);
    expect(caps.canDecided).toBe(false);
    expect(await roles.hasRoleReadGrant(approver.id)).toBe(false);
  });

  it("treasurer keeps canAll while finance is active even with approvals paused", async () => {
    const treasurer = await user("treasurer@example.com", {
      role: "treasurer",
      approvalsPaused: true,
    });
    const caps = await roles.searchCapabilitiesFor(treasurer.id);
    expect(caps.canAll).toBe(true); // finance still active
    expect(caps.canDecided).toBe(false); // approvals paused

    await prisma.user.update({
      where: { id: treasurer.id },
      data: { financePaused: true },
    });
    const paused = await roles.searchCapabilitiesFor(treasurer.id);
    expect(paused.canAll).toBe(false);
  });

  it("admin loses the grant only when every duty is paused", async () => {
    const admin = await user("admin@example.com", {
      role: "admin",
      approvalsPaused: true,
      financePaused: true,
    });
    expect((await roles.searchCapabilitiesFor(admin.id)).canAll).toBe(true); // admin duty active
    await prisma.user.update({ where: { id: admin.id }, data: { adminPaused: true } });
    expect((await roles.searchCapabilitiesFor(admin.id)).canAll).toBe(false);
  });
});

describe("team read grant", () => {
  let ownerId: string;
  let memberId: string;
  let outsiderId: string;
  let receiptOnClaim: string; // matching line item on a SUBMITTED claim
  let receiptDraftOnly: string; // matching line item but claim still draft
  let receiptOtherMinistry: string; // row on same claim, different ministry
  let claimId: string;

  beforeAll(async () => {
    ownerId = (await user("claim-owner@example.com")).id;
    memberId = (await user("team-member@example.com")).id;
    outsiderId = (await user("outsider@example.com")).id;

    const team = await prisma.team.create({
      data: {
        name: "Missions team",
        members: { create: [{ userId: memberId }] },
        ministries: { create: [{ code: "470" }] },
      },
    });
    expect(team.active).toBe(true);

    async function receipt(name: string) {
      return (
        await prisma.receipt.create({
          data: {
            userId: ownerId,
            filePath: `uploads/${ownerId}/${name}`,
            mimeType: "image/webp",
            originalName: name,
            sizeBytes: 10,
          },
        })
      ).id;
    }
    receiptOnClaim = await receipt("on-claim.jpg");
    receiptDraftOnly = await receipt("draft-only.jpg");
    receiptOtherMinistry = await receipt("other-ministry.jpg");

    const submitted = await prisma.reimbursement.create({
      data: {
        userId: ownerId,
        status: "submitted",
        receipts: {
          create: [{ receiptId: receiptOnClaim }, { receiptId: receiptOtherMinistry }],
        },
        lineItems: {
          create: [
            {
              receiptId: receiptOnClaim,
              description: "team supplies",
              amountCents: 1000,
              ministry: "470 Missions",
              sortOrder: 0,
            },
            {
              receiptId: receiptOtherMinistry,
              description: "unrelated",
              amountCents: 500,
              ministry: "237 Office",
              sortOrder: 1,
            },
          ],
        },
      },
    });
    claimId = submitted.id;

    await prisma.reimbursement.create({
      data: {
        userId: ownerId,
        status: "draft",
        receipts: { create: [{ receiptId: receiptDraftOnly }] },
        lineItems: {
          create: [
            {
              receiptId: receiptDraftOnly,
              description: "draft row",
              amountCents: 700,
              ministry: "470 Missions",
              sortOrder: 0,
            },
          ],
        },
      },
    });
  });

  it("membership in an active team with codes grants canTeam (and nothing else)", async () => {
    expect(await teams.hasTeamReadGrant(memberId)).toBe(true);
    expect(await teams.hasTeamReadGrant(outsiderId)).toBe(false);
    const caps = await roles.searchCapabilitiesFor(memberId);
    expect(caps).toEqual({ canAll: false, canDecided: false, canTeam: true });
  });

  it("teamPrefetch returns only matching receipts on non-draft claims, plus containing claims", async () => {
    const pre = await teams.teamPrefetch(memberId);
    expect(pre.receiptIds).toEqual([receiptOnClaim]); // grain: own line item only
    expect(pre.claimIds).toEqual([claimId]);
    expect(await teams.teamPrefetch(outsiderId)).toEqual({ receiptIds: [], claimIds: [] });
  });

  it("canReadReceiptViaTeam honors grain, draft exclusion, and membership", async () => {
    expect(await teams.canReadReceiptViaTeam(memberId, receiptOnClaim)).toBe(true);
    expect(await teams.canReadReceiptViaTeam(memberId, receiptDraftOnly)).toBe(false);
    expect(await teams.canReadReceiptViaTeam(memberId, receiptOtherMinistry)).toBe(false);
    expect(await teams.canReadReceiptViaTeam(outsiderId, receiptOnClaim)).toBe(false);
  });

  it("an excluded row and an archived team both revoke the grant", async () => {
    await prisma.lineItem.updateMany({
      where: { receiptId: receiptOnClaim },
      data: { isExcluded: true },
    });
    expect(await teams.canReadReceiptViaTeam(memberId, receiptOnClaim)).toBe(false);
    await prisma.lineItem.updateMany({
      where: { receiptId: receiptOnClaim },
      data: { isExcluded: false },
    });

    await prisma.team.updateMany({ data: { active: false } });
    expect(await teams.hasTeamReadGrant(memberId)).toBe(false);
    expect(await teams.teamPrefetch(memberId)).toEqual({ receiptIds: [], claimIds: [] });
    await prisma.team.updateMany({ data: { active: true } });
  });
});

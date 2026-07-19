import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { handleApi, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { requireTeamEditor } from "@/lib/teams-guard";
import { loadTeamsWithDetails, loadTeamMemberOptions } from "@/lib/teams-catalog";
import { isValidMinistryCode } from "@/lib/ministries";

export const runtime = "nodejs";

/**
 * The Teams catalog — named member groups associated with budget categories,
 * whose membership grants the read-only team visibility expansion
 * (docs/SEARCH_DESIGN.md §6.3 team amendment).
 *
 *   GET   teams (with members + codes) and the member directory for the
 *         editor — Approver-or-above (requireTeamEditor).
 *   PUT   replace the catalog — same gate, audited. Dropped teams are archived
 *         (active:false) and emptied of members so the grant they conferred
 *         ends immediately; never hard-deleted.
 *
 * Teams never touch roles, the roster, or any write path — membership only
 * widens READS, and the search/file routes re-derive the grant per request.
 */

const RowSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
  active: z.boolean().default(true),
  members: z.array(z.object({ userId: z.string().min(1) })).max(200).default([]),
  codes: z.array(z.string().trim()).max(100).default([]),
});
// knownIds: every team id the client had loaded when it built this payload.
// Archival is limited to ids the editor SAW — a stale editor must never
// silently archive (and de-grant) a team someone else created meanwhile.
const PutSchema = z.object({
  teams: z.array(RowSchema).max(200),
  knownIds: z.array(z.string()).max(500).optional(),
});

export async function GET() {
  return handleApi(async () => {
    await requireTeamEditor();
    const [teams, members] = await Promise.all([loadTeamsWithDetails(), loadTeamMemberOptions()]);
    return NextResponse.json({ teams, members });
  });
}

export async function PUT(req: Request) {
  return handleApi(async () => {
    const userId = await requireTeamEditor();
    const parsed = PutSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid teams payload", "team.invalid");
    const rows = parsed.data.teams;

    // Codes must be catalog-shaped (3 digits, never the reserved 999) — free
    // text can't be associated to a team, matching the code-based grant.
    for (const r of rows) {
      for (const code of r.codes) {
        if (!isValidMinistryCode(code)) {
          throw new ApiError(400, `Invalid budget category code: "${code}"`, "team.codeFormat", {
            code,
          });
        }
      }
    }

    // Every member must be a real user.
    const memberIds = [...new Set(rows.flatMap((r) => r.members.map((m) => m.userId)))];
    if (memberIds.length) {
      const found = await prisma.user.findMany({
        where: { id: { in: memberIds } },
        select: { id: true },
      });
      const known = new Set(found.map((u) => u.id));
      for (const id of memberIds) {
        if (!known.has(id)) {
          throw new ApiError(400, `Unknown member: ${id}`, "team.unknownMember", { id });
        }
      }
    }

    const existing = await prisma.team.findMany({ select: { id: true } });
    const existingIds = new Set(existing.map((e) => e.id));
    const keptIds = new Set(
      rows.filter((r) => r.id && existingIds.has(r.id)).map((r) => r.id as string)
    );

    const writes: Prisma.PrismaPromise<unknown>[] = [];
    // Upsert each team and replace its members/codes wholesale — trivial at
    // church scale, and it keeps the payload authoritative.
    rows.forEach((r, i) => {
      const data = { name: r.name, description: r.description, active: r.active, sortOrder: i };
      const memberSeen = new Set<string>();
      const members = r.members.filter((m) => !memberSeen.has(m.userId) && memberSeen.add(m.userId));
      const codes = [...new Set(r.codes)];
      if (r.id && existingIds.has(r.id)) {
        const id = r.id;
        writes.push(prisma.team.update({ where: { id }, data }));
        writes.push(prisma.teamMember.deleteMany({ where: { teamId: id } }));
        members.forEach((m) =>
          writes.push(prisma.teamMember.create({ data: { teamId: id, userId: m.userId } }))
        );
        writes.push(prisma.teamMinistry.deleteMany({ where: { teamId: id } }));
        codes.forEach((code) =>
          writes.push(prisma.teamMinistry.create({ data: { teamId: id, code } }))
        );
      } else {
        writes.push(
          prisma.team.create({
            data: {
              ...data,
              members: { create: members.map((m) => ({ userId: m.userId })) },
              ministries: { create: codes.map((code) => ({ code })) },
            },
          })
        );
      }
    });

    // Dropped teams are archived and emptied so their read grant ends now,
    // while the row survives for the audit trail.
    const seen = parsed.data.knownIds ? new Set(parsed.data.knownIds) : null;
    const dropped = existing
      .filter((e) => !keptIds.has(e.id) && (!seen || seen.has(e.id)))
      .map((e) => e.id);
    if (dropped.length) {
      writes.push(
        prisma.team.updateMany({ where: { id: { in: dropped } }, data: { active: false } })
      );
      writes.push(prisma.teamMember.deleteMany({ where: { teamId: { in: dropped } } }));
    }

    writes.push(
      prisma.auditEvent.create({
        data: { userId, action: "admin-teams", detail: JSON.stringify({ count: rows.length }) },
      })
    );
    await prisma.$transaction(writes);

    const [teams, members] = await Promise.all([loadTeamsWithDetails(), loadTeamMemberOptions()]);
    return NextResponse.json({ teams, members });
  });
}

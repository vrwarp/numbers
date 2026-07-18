import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { handleApi, requireUserId, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { requireMinistryEditor } from "@/lib/ministries-guard";
import {
  loadActiveMinistryEntries,
  loadActiveMinistryGroups,
  loadAllMinistryRows,
} from "@/lib/ministries-catalog";
import { isValidMinistryCode, RESERVED_UNCATEGORIZED_CODE } from "@/lib/ministries";

export const runtime = "nodejs";

/**
 * The church-wide budget-category catalog (docs/agent/ARCHITECTURE.md).
 *
 *   GET             active catalog for the "Ministry / Fund" pickers — any
 *                   signed-in user. `?scope=all` returns every row (active +
 *                   archived) for the treasurer's editor and is editor-gated.
 *   PUT             replace the catalog — treasurer/admin only, audited. The
 *                   composed "<code> <name>" a pick stores on a line item never
 *                   changes here, so history is never rewritten.
 */

const RowSchema = z.object({
  id: z.string().optional(),
  code: z.string().trim(),
  name: z.string().trim().min(1).max(100),
  group: z.string().trim().max(100).default(""),
  description: z.string().trim().max(500).default(""),
  active: z.boolean().default(true),
  // Optional default-approver Position (custom approval role). "" / null = none.
  defaultPositionId: z.string().nullish(),
});
const PutSchema = z.object({ ministries: z.array(RowSchema).max(500) });

export async function GET(req: Request) {
  return handleApi(async () => {
    if (new URL(req.url).searchParams.get("scope") === "all") {
      await requireMinistryEditor();
      return NextResponse.json({ rows: await loadAllMinistryRows() });
    }
    await requireUserId();
    const [groups, entries] = await Promise.all([
      loadActiveMinistryGroups(),
      loadActiveMinistryEntries(),
    ]);
    return NextResponse.json({ groups, entries });
  });
}

export async function PUT(req: Request) {
  return handleApi(async () => {
    const userId = await requireMinistryEditor();
    const parsed = PutSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid ministries payload", "ministry.invalid");
    const rows = parsed.data.ministries;

    // Codes are 3 digits and never the reserved 999; no two ACTIVE rows may
    // share a code (an archived row may keep an old code so history matches).
    const activeCodes = new Set<string>();
    for (const r of rows) {
      if (!isValidMinistryCode(r.code)) {
        throw new ApiError(
          400,
          `Account code must be 3 digits and not ${RESERVED_UNCATEGORIZED_CODE}: "${r.code}"`,
          "ministry.codeFormat",
          { code: r.code }
        );
      }
      if (r.active) {
        if (activeCodes.has(r.code)) {
          throw new ApiError(400, `Duplicate active code: ${r.code}`, "ministry.codeDuplicate", {
            code: r.code,
          });
        }
        activeCodes.add(r.code);
      }
    }

    // Order by (group first-seen, then code) and stamp sortOrder — the list
    // sorts itself, so the editor needs no manual reorder control.
    const groupOrder: string[] = [];
    for (const r of rows) if (!groupOrder.includes(r.group)) groupOrder.push(r.group);
    const ordered = [...rows].sort((a, b) => {
      const g = groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
      return g !== 0 ? g : a.code.localeCompare(b.code);
    });

    const existing = await prisma.ministry.findMany({ select: { id: true } });
    const existingIds = new Set(existing.map((e) => e.id));
    const keptIds = new Set(
      ordered.filter((r) => r.id && existingIds.has(r.id)).map((r) => r.id as string)
    );

    const writes: Prisma.PrismaPromise<unknown>[] = ordered.map((r, i) => {
      const data = {
        code: r.code,
        name: r.name,
        group: r.group,
        description: r.description,
        active: r.active,
        sortOrder: i,
        defaultPositionId: r.defaultPositionId || null,
      };
      return r.id && existingIds.has(r.id)
        ? prisma.ministry.update({ where: { id: r.id }, data })
        : prisma.ministry.create({ data });
    });

    // Rows the payload dropped entirely are archived, never hard-deleted, so a
    // historical composed value keeps a catalog match. The editor archives via
    // the toggle rather than dropping, so this is a safety net.
    const dropped = existing.filter((e) => !keptIds.has(e.id)).map((e) => e.id);
    if (dropped.length) {
      writes.push(
        prisma.ministry.updateMany({ where: { id: { in: dropped } }, data: { active: false } })
      );
    }
    writes.push(
      prisma.auditEvent.create({
        data: { userId, action: "admin-ministries", detail: JSON.stringify({ count: ordered.length }) },
      })
    );
    await prisma.$transaction(writes);
    return NextResponse.json({ rows: await loadAllMinistryRows() });
  });
}

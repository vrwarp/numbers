import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { handleApi, ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { requirePositionEditor } from "@/lib/positions-guard";
import { loadPositionsWithHolders, loadPositionMembers } from "@/lib/positions-catalog";

export const runtime = "nodejs";

/**
 * The Positions catalog — custom approval roles assigned to people and used as
 * budget-category default approvers (docs/agent/ARCHITECTURE.md).
 *
 *   GET   positions (with holders + live eligibility) and the member directory
 *         for the holder picker — editor-gated (treasurer/admin).
 *   PUT   replace the catalog — editor-gated, audited. Positions merely dropped
 *         from the payload are archived (active:false), never hard-deleted, so a
 *         Budget Category that still points at one keeps a valid reference. Ids
 *         listed in `deleteIds` are the explicit exception: they are hard-deleted
 *         (holders cascade, any Budget Category default pointing at them is set
 *         NULL by the FK) — the "remove" the editor's Delete button issues.
 *
 * A Position never grants approval authority (it only pre-fills the picker), so
 * this route touches nothing in the roster/ledger — it is plain app config.
 */

const HolderSchema = z.object({ userId: z.string().min(1) });
// Optional per-locale names for a custom position. "" / null → stored NULL, so
// display falls back to the English `name` (a built-in ignores these and
// localizes via the Positions.builtin catalog instead).
const localeName = z
  .string()
  .trim()
  .max(100)
  .nullish()
  .transform((v) => v || null);
const RowSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(100),
  nameZhHans: localeName,
  nameZhHant: localeName,
  description: z.string().trim().max(500).default(""),
  active: z.boolean().default(true),
  holders: z.array(HolderSchema).max(50).default([]),
});
const PutSchema = z.object({
  positions: z.array(RowSchema).max(200),
  // Existing position ids to hard-delete (vs. merely archive). Unknown ids are
  // ignored — deletion is idempotent.
  deleteIds: z.array(z.string()).max(200).default([]),
});

export async function GET() {
  return handleApi(async () => {
    await requirePositionEditor();
    const [positions, members] = await Promise.all([
      loadPositionsWithHolders(),
      loadPositionMembers(),
    ]);
    return NextResponse.json({ positions, members });
  });
}

export async function PUT(req: Request) {
  return handleApi(async () => {
    const userId = await requirePositionEditor();
    const parsed = PutSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "Invalid positions payload", "position.invalid");
    const rows = parsed.data.positions;
    const deleteIds = new Set(parsed.data.deleteIds);

    // Every holder must be a real user; de-duplicate holders within a position
    // (the @@unique guards the DB, but a clean payload keeps `order` contiguous).
    const holderIds = [...new Set(rows.flatMap((r) => r.holders.map((h) => h.userId)))];
    if (holderIds.length) {
      const found = await prisma.user.findMany({
        where: { id: { in: holderIds } },
        select: { id: true },
      });
      const known = new Set(found.map((u) => u.id));
      for (const id of holderIds) {
        if (!known.has(id)) {
          throw new ApiError(400, `Unknown holder: ${id}`, "position.unknownHolder", { id });
        }
      }
    }

    const existing = await prisma.position.findMany({ select: { id: true } });
    const existingIds = new Set(existing.map((e) => e.id));
    const keptIds = new Set(
      rows.filter((r) => r.id && existingIds.has(r.id)).map((r) => r.id as string)
    );

    const writes: Prisma.PrismaPromise<unknown>[] = [];
    // Upsert each position and replace its holders (delete + recreate keeps the
    // ordering authoritative and is trivial at church scale).
    rows.forEach((r, i) => {
      const data = {
        name: r.name,
        nameZhHans: r.nameZhHans,
        nameZhHant: r.nameZhHant,
        description: r.description,
        active: r.active,
        sortOrder: i,
      };
      const seen = new Set<string>();
      const holders = r.holders.filter((h) => !seen.has(h.userId) && seen.add(h.userId));
      if (r.id && existingIds.has(r.id)) {
        const id = r.id;
        writes.push(prisma.position.update({ where: { id }, data }));
        writes.push(prisma.positionHolder.deleteMany({ where: { positionId: id } }));
        holders.forEach((h, hi) =>
          writes.push(
            prisma.positionHolder.create({ data: { positionId: id, userId: h.userId, order: hi } })
          )
        );
      } else {
        writes.push(
          prisma.position.create({
            data: {
              ...data,
              holders: { create: holders.map((h, hi) => ({ userId: h.userId, order: hi })) },
            },
          })
        );
      }
    });

    // Explicitly deleted positions are hard-deleted: PositionHolder rows cascade
    // and any Ministry.defaultPositionId pointing here is set NULL by the FK.
    const toDelete = existing.filter((e) => deleteIds.has(e.id)).map((e) => e.id);
    if (toDelete.length) {
      writes.push(prisma.position.deleteMany({ where: { id: { in: toDelete } } }));
    }

    // Positions merely dropped from the payload (not explicitly deleted) are
    // archived (not deleted) and emptied of holders, so they stop routing but
    // any category default still resolves to a real (inactive) row rather than a
    // dangling id.
    const dropped = existing
      .filter((e) => !keptIds.has(e.id) && !deleteIds.has(e.id))
      .map((e) => e.id);
    if (dropped.length) {
      writes.push(
        prisma.position.updateMany({ where: { id: { in: dropped } }, data: { active: false } })
      );
      writes.push(prisma.positionHolder.deleteMany({ where: { positionId: { in: dropped } } }));
    }

    writes.push(
      prisma.auditEvent.create({
        data: {
          userId,
          action: "admin-positions",
          detail: JSON.stringify({ count: rows.length, deleted: toDelete.length }),
        },
      })
    );
    await prisma.$transaction(writes);

    const [positions, members] = await Promise.all([
      loadPositionsWithHolders(),
      loadPositionMembers(),
    ]);
    return NextResponse.json({ positions, members });
  });
}

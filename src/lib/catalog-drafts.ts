import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api";
import { canManageMinistries } from "@/lib/ministries-guard";
import { canManageTeams } from "@/lib/teams-guard";
import { isValidMinistryCode, RESERVED_UNCATEGORIZED_CODE } from "@/lib/ministries";

/**
 * Staged edits to church master data (Ministry / Team / Position) proposed
 * through the MCP backend (docs/MCP_DESIGN.md). SERVER ONLY (prisma).
 *
 * MCP never mutates a catalog directly: an assistant's edit is stored as a
 * PENDING CatalogDraft that a human reviews (Proposed Changes page) and applies
 * or discards. Both proposing AND applying require the SAME manage role the app
 * enforces for that entity — ministries/positions need canManageMinistries
 * (treasurer/admin), teams need canManageTeams (approver-or-above) — so a draft
 * can never do more than its author could do in the app. Membership and holder
 * assignment are deliberately not draftable here (they touch other people's
 * data); only descriptive fields and budget-category codes are.
 */

export type CatalogEntity = "ministry" | "team" | "position";
export type CatalogOperation = "create" | "update" | "archive" | "delete";

const ENTITIES: CatalogEntity[] = ["ministry", "team", "position"];
// Delete (hard) is only meaningful for positions; ministries/teams archive.
const OPERATIONS: Record<CatalogEntity, CatalogOperation[]> = {
  ministry: ["create", "update", "archive"],
  team: ["create", "update", "archive"],
  position: ["create", "update", "archive", "delete"],
};

type RoleFlags = { email: string; role: string; approvalsPaused: boolean; financePaused: boolean; adminPaused: boolean };

async function roleFlags(userId: string): Promise<RoleFlags | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true, approvalsPaused: true, financePaused: true, adminPaused: true },
  });
}

/** Whether a user may manage (and therefore draft/apply edits to) an entity. */
export async function canManageEntity(userId: string, entity: CatalogEntity): Promise<boolean> {
  const u = await roleFlags(userId);
  if (!u) return false;
  return entity === "team" ? canManageTeams(u) : canManageMinistries(u);
}

/** The set of entities a user may manage right now (drives what drafts they see). */
export async function manageableEntities(userId: string): Promise<CatalogEntity[]> {
  const u = await roleFlags(userId);
  if (!u) return [];
  const out: CatalogEntity[] = [];
  if (canManageMinistries(u)) out.push("ministry", "position");
  if (canManageTeams(u)) out.push("team");
  return out;
}

function requireManage(entity: CatalogEntity, can: boolean): void {
  if (!can) {
    const who = entity === "team" ? "an approver-or-above" : "a treasurer or admin";
    throw new ApiError(
      403,
      `Managing ${entity}s requires ${who} role, which this account does not have.`,
      "catalogRoleRequired",
      { entity }
    );
  }
}

// --- Per-entity field validation --------------------------------------------

const ministrySchema = z.object({
  code: z.string().trim().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  group: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  active: z.boolean().optional(),
});
const teamSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  active: z.boolean().optional(),
  codes: z.array(z.string().trim()).max(100).optional(),
});
const positionSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  nameZhHans: z.string().trim().max(100).optional(),
  nameZhHant: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  active: z.boolean().optional(),
});

function invalid(message: string, params?: Record<string, string | number>): never {
  throw new ApiError(400, message, "catalogInvalidFields", params);
}

/** Validate + clean the proposed fields for an entity/operation. */
function validateFields(
  entity: CatalogEntity,
  operation: CatalogOperation,
  raw: unknown
): Record<string, unknown> {
  if (operation === "archive" || operation === "delete") return {};
  const schema = entity === "ministry" ? ministrySchema : entity === "team" ? teamSchema : positionSchema;
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) invalid("The proposed fields are not valid for this entity.");
  const fields = parsed.data as Record<string, unknown>;

  if (operation === "create") {
    if (entity === "ministry" && (!fields.code || !fields.name)) invalid("A new ministry needs a code and a name.");
    if (entity !== "ministry" && !fields.name) invalid(`A new ${entity} needs a name.`);
  }
  if (entity === "ministry" && typeof fields.code === "string" && fields.code) {
    if (!isValidMinistryCode(fields.code)) {
      invalid(`Account code must be 3 digits and not ${RESERVED_UNCATEGORIZED_CODE}.`, { code: fields.code });
    }
  }
  if (entity === "team" && Array.isArray(fields.codes)) {
    for (const code of fields.codes as string[]) {
      if (!isValidMinistryCode(code)) invalid(`Invalid budget-category code: "${code}".`, { code });
    }
  }
  if (operation === "update" && Object.keys(fields).length === 0) {
    invalid("An update needs at least one field to change.");
  }
  return fields;
}

// --- Draft CRUD -------------------------------------------------------------

export interface DraftInput {
  entity: CatalogEntity;
  operation: CatalogOperation;
  targetId?: string;
  fields?: unknown;
  note?: string;
}

function draftDto(
  d: {
    id: string;
    entity: string;
    operation: string;
    targetId: string | null;
    proposedJson: string;
    note: string;
    status: string;
    createdAt: Date;
    resolvedAt: Date | null;
    user?: { fullName: string | null; email: string } | null;
  },
  targetName?: string | null
) {
  let fields: unknown = {};
  try {
    fields = JSON.parse(d.proposedJson);
  } catch {
    fields = {};
  }
  return {
    id: d.id,
    entity: d.entity,
    operation: d.operation,
    targetId: d.targetId,
    targetLabel: targetName ?? null,
    fields,
    note: d.note || null,
    status: d.status,
    createdAt: d.createdAt.toISOString(),
    resolvedAt: d.resolvedAt?.toISOString() ?? null,
    ...(d.user ? { author: { name: d.user.fullName || d.user.email, email: d.user.email } } : {}),
  };
}

/** Existence + label of the target row an update/archive/delete points at. */
async function targetLabel(entity: CatalogEntity, targetId: string): Promise<string | null> {
  if (entity === "ministry") {
    const m = await prisma.ministry.findUnique({ where: { id: targetId }, select: { code: true, name: true } });
    return m ? `${m.code} ${m.name}` : null;
  }
  if (entity === "team") {
    const t = await prisma.team.findUnique({ where: { id: targetId }, select: { name: true } });
    return t ? t.name : null;
  }
  const p = await prisma.position.findUnique({ where: { id: targetId }, select: { name: true } });
  return p ? p.name : null;
}

/** Stage a catalog edit as a pending draft (requires the entity's manage role). */
export async function createCatalogDraft(userId: string, input: DraftInput) {
  const { entity, operation } = input;
  if (!ENTITIES.includes(entity)) throw new ApiError(400, "Unknown catalog entity.", "catalogEntityInvalid");
  if (!OPERATIONS[entity].includes(operation)) {
    throw new ApiError(400, `Operation "${operation}" is not valid for ${entity}.`, "catalogOperationInvalid");
  }
  requireManage(entity, await canManageEntity(userId, entity));

  if (operation === "create") {
    if (input.targetId) throw new ApiError(400, "A create draft must not target an existing row.", "catalogTargetInvalid");
  } else {
    if (!input.targetId) throw new ApiError(400, `A ${operation} draft must name a target id.`, "catalogTargetRequired");
    const label = await targetLabel(entity, input.targetId);
    if (label === null) throw new ApiError(404, `That ${entity} was not found.`, "catalogTargetNotFound");
  }

  const fields = validateFields(entity, operation, input.fields);
  const draft = await prisma.catalogDraft.create({
    data: {
      userId,
      entity,
      operation,
      targetId: input.targetId ?? null,
      proposedJson: JSON.stringify(fields),
      note: (input.note ?? "").slice(0, 500),
    },
  });
  return draftDto(draft);
}

/** Pending drafts the user may act on: for entities they manage, plus any they
 *  authored. */
export async function listCatalogDrafts(
  userId: string,
  opts: { status?: string; entity?: CatalogEntity } = {}
) {
  const manageable = await manageableEntities(userId);
  const status = opts.status ?? "pending";
  const rows = await prisma.catalogDraft.findMany({
    where: {
      status,
      ...(opts.entity ? { entity: opts.entity } : {}),
      OR: [{ entity: { in: manageable } }, { userId }],
    },
    orderBy: { createdAt: "desc" },
    include: { user: { select: { fullName: true, email: true } } },
  });
  return Promise.all(
    rows.map(async (d) =>
      draftDto(d, d.targetId ? await targetLabel(d.entity as CatalogEntity, d.targetId) : null)
    )
  );
}

/** Discard a pending draft (its author, or a manager of its entity). */
export async function discardCatalogDraft(userId: string, id: string) {
  const draft = await prisma.catalogDraft.findUnique({ where: { id } });
  if (!draft || draft.status !== "pending") throw new ApiError(404, "Draft not found.", "catalogDraftNotFound");
  const allowed = draft.userId === userId || (await canManageEntity(userId, draft.entity as CatalogEntity));
  if (!allowed) throw new ApiError(404, "Draft not found.", "catalogDraftNotFound");
  await prisma.catalogDraft.update({
    where: { id },
    data: { status: "discarded", resolvedAt: new Date(), resolvedById: userId },
  });
  return { ok: true };
}

// --- Apply (human action from the review page) ------------------------------

/** Apply a pending draft: re-check the manage role, perform the targeted
 *  mutation, mark the draft applied, and audit it. */
export async function applyCatalogDraft(userId: string, id: string): Promise<{ ok: true }> {
  const draft = await prisma.catalogDraft.findUnique({ where: { id } });
  if (!draft || draft.status !== "pending") throw new ApiError(404, "Draft not found.", "catalogDraftNotFound");
  const entity = draft.entity as CatalogEntity;
  requireManage(entity, await canManageEntity(userId, entity));

  const fields = validateFields(entity, draft.operation as CatalogOperation, safeParse(draft.proposedJson));
  const writes = await mutationWrites(entity, draft.operation as CatalogOperation, draft.targetId, fields);

  writes.push(
    prisma.catalogDraft.update({
      where: { id },
      data: { status: "applied", resolvedAt: new Date(), resolvedById: userId },
    })
  );
  writes.push(
    prisma.auditEvent.create({
      data: {
        userId,
        action: "apply-catalog-draft",
        detail: JSON.stringify({
          entity,
          operation: draft.operation,
          targetId: draft.targetId,
          draftId: id,
          fields,
        }),
      },
    })
  );
  await prisma.$transaction(writes);
  return { ok: true };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** Build the Prisma writes for one applied draft. Kept single-entity and
 *  targeted (the app's catalog PUT rebuilds the whole list; here we touch just
 *  the one row), archiving rather than deleting except for a position delete. */
async function mutationWrites(
  entity: CatalogEntity,
  operation: CatalogOperation,
  targetId: string | null,
  fields: Record<string, unknown>
) {
  const writes: import("@prisma/client").Prisma.PrismaPromise<unknown>[] = [];

  if (entity === "ministry") {
    if (operation === "archive") {
      writes.push(prisma.ministry.update({ where: { id: targetId! }, data: { active: false } }));
      return writes;
    }
    // Enforce the "no two active rows share a code" rule against the live table.
    if (typeof fields.code === "string" && fields.code) {
      const clash = await prisma.ministry.findFirst({
        where: { code: fields.code, active: true, ...(targetId ? { NOT: { id: targetId } } : {}) },
        select: { id: true },
      });
      if (clash) throw new ApiError(400, `Another active ministry already uses code ${fields.code}.`, "catalogInvalidFields", { code: fields.code });
    }
    if (operation === "create") {
      const max = await prisma.ministry.aggregate({ _max: { sortOrder: true } });
      writes.push(
        prisma.ministry.create({
          data: {
            code: String(fields.code),
            name: String(fields.name),
            group: (fields.group as string) ?? "",
            description: (fields.description as string) ?? "",
            active: (fields.active as boolean) ?? true,
            sortOrder: (max._max.sortOrder ?? -1) + 1,
          },
        })
      );
    } else {
      writes.push(prisma.ministry.update({ where: { id: targetId! }, data: ministryData(fields) }));
    }
    return writes;
  }

  if (entity === "team") {
    if (operation === "archive") {
      writes.push(prisma.team.update({ where: { id: targetId! }, data: { active: false } }));
      // End the read grant the membership conferred, matching the catalog PUT.
      writes.push(prisma.teamMember.deleteMany({ where: { teamId: targetId! } }));
      return writes;
    }
    if (operation === "create") {
      const max = await prisma.team.aggregate({ _max: { sortOrder: true } });
      const codes = uniqueCodes(fields.codes);
      writes.push(
        prisma.team.create({
          data: {
            name: String(fields.name),
            description: (fields.description as string) ?? "",
            active: (fields.active as boolean) ?? true,
            sortOrder: (max._max.sortOrder ?? -1) + 1,
            ministries: { create: codes.map((code) => ({ code })) },
          },
        })
      );
    } else {
      writes.push(prisma.team.update({ where: { id: targetId! }, data: teamData(fields) }));
      if (Array.isArray(fields.codes)) {
        writes.push(prisma.teamMinistry.deleteMany({ where: { teamId: targetId! } }));
        uniqueCodes(fields.codes).forEach((code) =>
          writes.push(prisma.teamMinistry.create({ data: { teamId: targetId!, code } }))
        );
      }
    }
    return writes;
  }

  // position
  if (operation === "delete") {
    writes.push(prisma.position.delete({ where: { id: targetId! } }));
    return writes;
  }
  if (operation === "archive") {
    writes.push(prisma.position.update({ where: { id: targetId! }, data: { active: false } }));
    writes.push(prisma.positionHolder.deleteMany({ where: { positionId: targetId! } }));
    return writes;
  }
  if (operation === "create") {
    const max = await prisma.position.aggregate({ _max: { sortOrder: true } });
    writes.push(
      prisma.position.create({
        data: {
          name: String(fields.name),
          nameZhHans: (fields.nameZhHans as string) ?? null,
          nameZhHant: (fields.nameZhHant as string) ?? null,
          description: (fields.description as string) ?? "",
          active: (fields.active as boolean) ?? true,
          sortOrder: (max._max.sortOrder ?? -1) + 1,
        },
      })
    );
  } else {
    writes.push(prisma.position.update({ where: { id: targetId! }, data: positionData(fields) }));
  }
  return writes;
}

function ministryData(f: Record<string, unknown>) {
  const d: Record<string, unknown> = {};
  for (const k of ["code", "name", "group", "description", "active"] as const) {
    if (f[k] !== undefined) d[k] = f[k];
  }
  return d;
}
function teamData(f: Record<string, unknown>) {
  const d: Record<string, unknown> = {};
  for (const k of ["name", "description", "active"] as const) {
    if (f[k] !== undefined) d[k] = f[k];
  }
  return d;
}
function positionData(f: Record<string, unknown>) {
  const d: Record<string, unknown> = {};
  for (const k of ["name", "nameZhHans", "nameZhHant", "description", "active"] as const) {
    if (f[k] !== undefined) d[k] = f[k];
  }
  return d;
}
function uniqueCodes(codes: unknown): string[] {
  return Array.isArray(codes) ? [...new Set(codes.filter((c): c is string => typeof c === "string"))] : [];
}

// --- Editor list helpers (ids + non-PII, for the draft tools) ---------------

export async function listTeamsForEditor() {
  const rows = await prisma.team.findMany({
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      active: true,
      ministries: { select: { code: true } },
      _count: { select: { members: true } },
    },
  });
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description || null,
    active: t.active,
    codes: t.ministries.map((m) => m.code),
    memberCount: t._count.members,
  }));
}

export async function listPositionsForEditor() {
  const rows = await prisma.position.findMany({
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }],
    select: {
      id: true,
      name: true,
      nameZhHans: true,
      nameZhHant: true,
      description: true,
      active: true,
      _count: { select: { holders: true } },
    },
  });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    nameZhHans: p.nameZhHans,
    nameZhHant: p.nameZhHant,
    description: p.description || null,
    active: p.active,
    holderCount: p._count.holders,
  }));
}

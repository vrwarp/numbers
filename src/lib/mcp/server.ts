import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { ApiError } from "@/lib/api";
import { parseDollarsToCents } from "@/lib/money";
import { userIdFrom, approvalUrlFor } from "@/lib/mcp/auth";
import type { McpScope } from "@/lib/mcp/scopes";
import { listReceipts, getReceipt, listClaims, getClaim, listMinistries } from "@/lib/mcp/data";
import {
  createDraftClaim,
  addReceiptsToClaim,
  resolveClaimReceipts,
  resolveReceiptsToAdd,
} from "@/lib/claims";
import { updateClaimSettings, updateLineItem } from "@/lib/claim-edits";
import {
  canManageEntity,
  createCatalogDraft,
  discardCatalogDraft,
  listCatalogDrafts,
  listTeamsForEditor,
  listPositionsForEditor,
  type CatalogEntity,
} from "@/lib/catalog-drafts";

/**
 * The Numbers MCP tool surface (docs/MCP_DESIGN.md). A small, task-oriented set
 * — read receipts and claims, help draft — deliberately capped well under the
 * "context bloat" threshold. Every tool is scope-gated against the presenting
 * token's grants and owner-scoped to that token's user; writes are bounded to
 * DRAFT claims and never touch signing, submit, approval, payment, PDF
 * generation, or verification (that stays a human in the app — invariant 3/9).
 */

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** A scope the presenting token lacks — surfaced as a clear, actionable tool
 *  error rather than a silent failure. */
class ScopeError extends Error {}

function grantedScopes(extra: Extra): string[] {
  return extra.authInfo?.scopes ?? [];
}

function requireScope(extra: Extra, scope: McpScope): void {
  if (!grantedScopes(extra).includes(scope)) {
    throw new ScopeError(
      `This action needs the "${scope}" scope, which this connection's token was not granted. ` +
        `The token's owner can create a token with that scope in Numbers → Profile → Connections.`
    );
  }
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Run a tool body, turning expected failures (scope/ApiError) into readable
 *  tool errors and never leaking internal error detail. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof ScopeError) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    if (err instanceof ApiError) {
      const code = err.code ? ` [${err.code}]` : "";
      return { content: [{ type: "text", text: `${err.message}${code}` }], isError: true };
    }
    console.error("MCP tool error:", err);
    return { content: [{ type: "text", text: "The request could not be completed." }], isError: true };
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const DRAFT_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/** The sanitized claim plus `approvalUrl` — the review page a human opens to
 *  verify and approve the draft. The assistant can hand this URL to the user. */
async function claimWithApproval(extra: Extra, userId: string, claimId: string) {
  const claim = await getClaim(userId, claimId);
  return { ...claim, approvalUrl: approvalUrlFor(extra.authInfo, `/claims/${claim.id}`) };
}

const claimStatus = z
  .enum(["draft", "generated", "submitted", "rejected", "approved", "paid"])
  .describe("Filter by claim status.");
const receiptStatus = z.enum(["unassigned", "processed"]).describe("Filter by receipt status.");
const limit = z.number().int().min(1).max(100).optional().describe("Max rows to return (default 20).");
const offset = z.number().int().min(0).optional().describe("Rows to skip, for paging (use nextOffset).");
const query = z.string().max(200).optional().describe("Case-sensitive substring filter.");

export function registerMcpTools(server: McpServer): void {
  // --- Reads ---------------------------------------------------------------

  server.registerTool(
    "numbers_list_receipts",
    {
      title: "List receipts",
      description:
        "List the user's receipts (their 'shoebox'), newest first, with the extracted merchant/date/totals and which claims each is on. Supports status filter, substring query, and paging.",
      inputSchema: { status: receiptStatus.optional(), query, limit, offset },
      annotations: READ_ONLY,
    },
    (args, extra) =>
      run(() => {
        requireScope(extra, "receipts:read");
        return listReceipts(userIdFrom(extra.authInfo), args);
      })
  );

  server.registerTool(
    "numbers_get_receipt",
    {
      title: "Get a receipt",
      description: "Fetch one receipt by id with its extracted fields and the claims it is attached to.",
      inputSchema: { receiptId: z.string().min(1).describe("The receipt id.") },
      annotations: READ_ONLY,
    },
    (args, extra) =>
      run(() => {
        requireScope(extra, "receipts:read");
        return getReceipt(userIdFrom(extra.authInfo), args.receiptId);
      })
  );

  server.registerTool(
    "numbers_list_claims",
    {
      title: "List claims",
      description:
        "List the user's reimbursement claims, newest first, with status, total, and line-item/receipt counts. Supports status filter, substring query, and paging. Use to answer 'where is my claim'.",
      inputSchema: { status: claimStatus.optional(), query, limit, offset },
      annotations: READ_ONLY,
    },
    (args, extra) =>
      run(() => {
        requireScope(extra, "claims:read");
        return listClaims(userIdFrom(extra.authInfo), args);
      })
  );

  server.registerTool(
    "numbers_get_claim",
    {
      title: "Get a claim",
      description:
        "Fetch one claim by id with its line items, attached receipts, lifecycle timestamps, and a verification summary (what still blocks the human review gate).",
      inputSchema: { claimId: z.string().min(1).describe("The claim id.") },
      annotations: READ_ONLY,
    },
    (args, extra) =>
      run(() => {
        requireScope(extra, "claims:read");
        return getClaim(userIdFrom(extra.authInfo), args.claimId);
      })
  );

  server.registerTool(
    "numbers_list_ministries",
    {
      title: "List ministries",
      description:
        "List the active budget categories (ministries). Each 'value' is exactly what to pass as a line item's or claim's ministry.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    (_args, extra) =>
      run(() => {
        // Reference data any read/draft grant can see.
        if (!["receipts:read", "claims:read", "claims:draft"].some((s) => grantedScopes(extra).includes(s))) {
          throw new ScopeError('This action needs a read scope ("claims:read" or "receipts:read").');
        }
        return listMinistries();
      })
  );

  // --- Draft help (writes, bounded to draft claims) ------------------------

  server.registerTool(
    "numbers_create_draft_claim",
    {
      title: "Create a draft claim",
      description:
        "Create a new DRAFT reimbursement claim from one or more of the user's receipts (one line item per receipt, using each receipt's already-extracted data). No AI is called — receipts the background worker hasn't read yet come in as blank rows to fill. The claim starts unverified; a human reviews and generates the PDF. Returns the claim plus an approvalUrl to give the user.",
      inputSchema: {
        receiptIds: z.array(z.string().min(1)).min(1).describe("Receipt ids to build the claim from."),
      },
      annotations: DRAFT_WRITE,
    },
    (args, extra) =>
      run(async () => {
        requireScope(extra, "claims:draft");
        const userId = userIdFrom(extra.authInfo);
        const receipts = await resolveClaimReceipts(userId, args.receiptIds);
        const claim = await createDraftClaim(userId, receipts, "stored");
        return claimWithApproval(extra, userId, claim.id);
      })
  );

  server.registerTool(
    "numbers_add_receipts_to_claim",
    {
      title: "Add receipts to a draft claim",
      description:
        "Append one or more receipts to an existing DRAFT claim (one line item each, from stored data — no AI call). Fails if the claim is not a draft or a receipt is already on it. Returns the updated claim plus an approvalUrl to give the user.",
      inputSchema: {
        claimId: z.string().min(1).describe("The draft claim id."),
        receiptIds: z.array(z.string().min(1)).min(1).describe("Receipt ids to add."),
      },
      annotations: DRAFT_WRITE,
    },
    (args, extra) =>
      run(async () => {
        requireScope(extra, "claims:draft");
        const userId = userIdFrom(extra.authInfo);
        const receipts = await resolveReceiptsToAdd(userId, args.claimId, args.receiptIds);
        await addReceiptsToClaim(userId, args.claimId, receipts, "stored");
        return claimWithApproval(extra, userId, args.claimId);
      })
  );

  server.registerTool(
    "numbers_update_claim_settings",
    {
      title: "Update draft claim settings",
      description:
        "Edit a DRAFT claim's description, single-ministry mode, and (in single-ministry mode) the claim-level ministry/event that mirror onto every row. Setting the ministry here un-verifies the affected rows. Returns the updated claim plus an approvalUrl to give the user.",
      inputSchema: {
        claimId: z.string().min(1).describe("The draft claim id."),
        description: z.string().max(300).optional().describe("One-sentence 'what is this claim for'."),
        singleMinistry: z.boolean().optional().describe("Whether one ministry applies to the whole claim."),
        ministry: z.string().max(100).optional().describe("Claim-level ministry (single-ministry mode). Use a ministries 'value'."),
        event: z.string().max(100).optional().describe("Claim-level event label (single-ministry mode)."),
      },
      annotations: DRAFT_WRITE,
    },
    (args, extra) =>
      run(async () => {
        requireScope(extra, "claims:draft");
        const userId = userIdFrom(extra.authInfo);
        await updateClaimSettings(userId, args.claimId, {
          claimDescription: args.description,
          singleMinistry: args.singleMinistry,
          claimMinistry: args.ministry,
          claimEvent: args.event,
        });
        return claimWithApproval(extra, userId, args.claimId);
      })
  );

  server.registerTool(
    "numbers_update_line_item",
    {
      title: "Update a draft line item",
      description:
        "Edit one line item on a DRAFT claim: description, amount (in dollars), ministry, event, or exclude/include it. Amount and content edits keep the row UNVERIFIED — a human still verifies each row before the claim can generate. This tool cannot verify a row. Returns the updated claim plus an approvalUrl to give the user.",
      inputSchema: {
        lineItemId: z.string().min(1).describe("The line item id."),
        description: z.string().min(1).max(300).optional().describe("Row description."),
        amount: z.union([z.number(), z.string()]).optional().describe("Row amount in dollars (e.g. 12.34 or '12.34'); may be negative for a net refund."),
        ministry: z.string().max(100).optional().describe("Ministry for this row. Use a ministries 'value'."),
        event: z.string().max(100).optional().describe("Event label for this row."),
        isExcluded: z.boolean().optional().describe("Exclude this row from the claim (or restore it)."),
      },
      annotations: DRAFT_WRITE,
    },
    (args, extra) =>
      run(async () => {
        requireScope(extra, "claims:draft");
        const userId = userIdFrom(extra.authInfo);
        const { lineItem } = await updateLineItem(userId, args.lineItemId, {
          description: args.description,
          amountCents: args.amount === undefined ? undefined : parseDollarsToCents(args.amount),
          ministry: args.ministry,
          event: args.event,
          isExcluded: args.isExcluded,
        });
        return claimWithApproval(extra, userId, lineItem.reimbursementId);
      })
  );

  // --- Catalog (ministries / teams / positions): list + draft edits --------
  // Edits are never applied directly — they stage a draft a human applies from
  // the Proposed Changes page. Every catalog tool additionally requires the
  // manage role the app enforces for that entity.

  async function requireEntityRole(userId: string, entity: CatalogEntity): Promise<void> {
    if (!(await canManageEntity(userId, entity))) {
      const who = entity === "team" ? "an approver-or-above" : "a treasurer or admin";
      throw new ApiError(
        403,
        `Managing ${entity}s requires ${who} role, which this account does not have.`,
        "catalogRoleRequired",
        { entity }
      );
    }
  }

  server.registerTool(
    "numbers_list_teams",
    {
      title: "List teams",
      description:
        "List the church's teams (budget-category visibility groups) with their ids, budget codes, active state, and member count (no member identities). Requires an approver-or-above role.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    (_args, extra) =>
      run(async () => {
        requireScope(extra, "catalog:read");
        const userId = userIdFrom(extra.authInfo);
        await requireEntityRole(userId, "team");
        return listTeamsForEditor();
      })
  );

  server.registerTool(
    "numbers_list_positions",
    {
      title: "List positions",
      description:
        "List the church's positions (custom approval roles) with their ids, names, active state, and holder count (no holder identities). Requires a treasurer or admin role.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    (_args, extra) =>
      run(async () => {
        requireScope(extra, "catalog:read");
        const userId = userIdFrom(extra.authInfo);
        await requireEntityRole(userId, "position");
        return listPositionsForEditor();
      })
  );

  server.registerTool(
    "numbers_draft_catalog_edit",
    {
      title: "Draft a catalog edit",
      description:
        "STAGE an edit to a ministry, team, or position as a pending draft for a human to review and apply on the Proposed Changes page — this applies nothing itself. Requires the manage role for that entity (treasurer/admin for ministries & positions; approver-or-above for teams). Provide only the fields that apply to the entity; membership and holder assignment cannot be drafted here. Returns the staged draft plus an approvalUrl to give the user.",
      inputSchema: {
        entity: z.enum(["ministry", "team", "position"]).describe("Which catalog to edit."),
        operation: z
          .enum(["create", "update", "archive", "delete"])
          .describe("create; update fields; archive (hide); delete (positions only, permanent)."),
        targetId: z.string().min(1).optional().describe("Existing row id for update/archive/delete (omit for create)."),
        name: z.string().max(100).optional().describe("Name (ministry/team/position)."),
        code: z.string().max(10).optional().describe("Ministry 3-digit account code."),
        group: z.string().max(100).optional().describe("Ministry chart-of-accounts group label."),
        description: z.string().max(500).optional().describe("Optional description/guidance."),
        active: z.boolean().optional().describe("Active state."),
        codes: z.array(z.string()).max(100).optional().describe("Team's budget-category codes."),
        nameZhHans: z.string().max(100).optional().describe("Position name (Simplified Chinese)."),
        nameZhHant: z.string().max(100).optional().describe("Position name (Traditional Chinese)."),
        note: z.string().max(500).optional().describe("Rationale for the human reviewer."),
      },
      annotations: DRAFT_WRITE,
    },
    (args, extra) =>
      run(async () => {
        requireScope(extra, "catalog:draft");
        const { entity, operation, targetId, note, ...rest } = args;
        // Assemble only the provided fields; validateFields strips those that
        // don't apply to the chosen entity.
        const fields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rest)) if (v !== undefined) fields[k] = v;
        const draft = await createCatalogDraft(userIdFrom(extra.authInfo), { entity, operation, targetId, fields, note });
        return { ...draft, approvalUrl: approvalUrlFor(extra.authInfo, "/catalog-drafts") };
      })
  );

  server.registerTool(
    "numbers_list_catalog_drafts",
    {
      title: "List catalog-edit drafts",
      description:
        "List pending catalog-edit drafts the account may act on (for entities it manages, plus any it authored). Applying/discarding happens on the Proposed Changes page or via numbers_discard_catalog_draft.",
      inputSchema: {
        entity: z.enum(["ministry", "team", "position"]).optional().describe("Filter by entity."),
        status: z.enum(["pending", "applied", "discarded"]).optional().describe("Draft status (default pending)."),
      },
      annotations: READ_ONLY,
    },
    (args, extra) =>
      run(() => {
        requireScope(extra, "catalog:read");
        return listCatalogDrafts(userIdFrom(extra.authInfo), { entity: args.entity, status: args.status });
      })
  );

  server.registerTool(
    "numbers_discard_catalog_draft",
    {
      title: "Discard a catalog-edit draft",
      description: "Discard a pending catalog-edit draft (its author, or a manager of its entity). Does not apply it.",
      inputSchema: { draftId: z.string().min(1).describe("The draft id.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args, extra) =>
      run(() => {
        requireScope(extra, "catalog:draft");
        return discardCatalogDraft(userIdFrom(extra.authInfo), args.draftId);
      })
  );
}

# MCP backend — design & contract

Lets a user connect an AI assistant (Claude custom connectors, ChatGPT developer-mode
apps) to Numbers over the **Model Context Protocol**. The assistant can **read** the user's
receipts and claims, **help draft** claims, and **propose** edits to church master data — but
it can **never sign, submit, approve, pay, generate a PDF, or verify a row**, and **no secret
is ever exposed over MCP**. This document is the implementation contract; keep it in step with
the code the way the other design docs are.

## Transport & endpoint

- **Streamable HTTP only**, at **`/api/mcp`** (`src/app/api/[transport]/route.ts`, `basePath:"/api"`,
  `disableSse:true`). SSE (the deprecated legacy transport) is off. The handler is **stateless**
  (no session affinity) — forward-compatible with the stateless-transport direction and with
  serverless scale.
- Built on **`mcp-handler`** (Vercel) wrapping **`@modelcontextprotocol/sdk`** (≥1.26). Spec
  revision targeted: `2025-06-18`.
- `runtime="nodejs"`. No tool calls an LLM, so requests are fast — there is no extraction/quota
  wait to sit through.

## Authentication — personal access tokens (PAT)

The app's only browser credential is the `numbers_session` HMAC cookie, which an MCP client
can't carry, so the backend uses **personal access tokens** the user mints in
**Profile → AI assistant connections** (`src/components/mcp/ConnectionsCard.tsx`).

- **Format** `nmbr_pat_<43-char base64url>` (256 bits of randomness). Stored **only** as its
  SHA-256 hash (`McpToken.tokenHash`, unique) — a DB read can never reveal a live token. The
  raw secret is returned **once**, by `POST /api/mcp-tokens`, and never again. `src/lib/mcp/tokens.ts`.
- **Verification** (`src/lib/mcp/auth.ts` → `verifyMcpTokenSecret`): a bearer resolves to
  `{userId, scopes}` by indexed hash lookup; malformed / unknown / revoked / expired → 401.
  `lastUsedAt` is a fire-and-forget touch (never gates a request). `withMcpAuth(required)` maps
  a missing/invalid token to 401.
- The `extra.userId` on the resolved `AuthInfo` is the tenant key — the MCP analogue of
  `requireUserId()`. **Every tool query is owner-scoped** (`where:{userId}`); MCP never uses the
  role/team cross-tenant read grants — an assistant sees only its user's own receipts/claims.
- **Revocable** anytime (`DELETE /api/mcp-tokens/[id]`), optional expiry.

**PAT now, OAuth later.** The scope layer is the stable contract; an OAuth 2.1 authorization
server (RFC 9728 metadata + consent screen) can be added later as a front-end that mints the
same scoped, audience-bound tokens, without reworking the tools.

## Scopes (`src/lib/mcp/scopes.ts`)

The user picks a subset per token — this is the access-control surface. There is **no** signing/
submit/approval/pdf scope by design — **and no scope that makes the app call an LLM**: the MCP
backend never spends the deployment's AI quota (see Tools).

| scope | grants |
|---|---|
| `receipts:read` | list/read own receipts (sanitized) |
| `claims:read` | list/read own claims + status |
| `claims:draft` | create/edit **draft** claims |
| `catalog:read` | list ministries/teams/positions (**also** needs the manage role) |
| `catalog:draft` | stage catalog edits as drafts (**also** needs the manage role) |
| `feedback:read` | view user feedback reports (**also** needs the app-admin role) |
| `feedback:triage` | move a feedback report new → triaged → closed (**also** needs the app-admin role) |

Enforcement is **per tool** inside the callback (`requireScope`); an ungranted scope returns a
clear, actionable tool error (PAT has no OAuth step-up).

The role-gated scopes are also enforced **at mint time** so a token can never carry a capability
its owner lacks: `mcpAccessibleScopes(userId)` (`src/lib/mcp/access.ts`) resolves the exact same
gates the tools use — `catalog:*` needs the catalog manage role (`canManageMinistries` for
ministries/positions, `canManageTeams` for teams — both honoring the A10 duty pauses), `feedback:*`
needs app-admin — and the connections settings UI offers only that subset (`GET /api/mcp-tokens`
returns `availableScopes`) while `POST /api/mcp-tokens` refuses any scope outside it
(`mcpScopeForbidden`). A role change is re-read on every request, so a lost role removes the option;
existing tokens still fail closed at the tool layer.

## Tools (`src/lib/mcp/server.ts`)

Small, task-oriented surface (kept well under the context-bloat threshold), each annotated
(`readOnlyHint`/`destructiveHint`/`openWorldHint`). Money crosses the LLM boundary as **dollars**
and converts via `src/lib/money.ts` (invariant 1); outputs carry both cents and a decimal string.

**Read:** `numbers_list_receipts`, `numbers_get_receipt`, `numbers_list_claims`,
`numbers_get_claim` (with a `verification` summary of what still blocks the human gate),
`numbers_list_ministries`.

**Draft help (write, bounded to `status:"draft"`, reusing the app's own service logic so all
invariants hold):** `numbers_create_draft_claim`, `numbers_add_receipts_to_claim`,
`numbers_update_claim_settings`, `numbers_update_line_item` (**cannot** set `isVerified`).

**Catalog (list + draft edits):** `numbers_list_teams`, `numbers_list_positions`,
`numbers_draft_catalog_edit`, `numbers_list_catalog_drafts`, `numbers_discard_catalog_draft`.

**Feedback triage (admin):** `numbers_list_feedback`, `numbers_get_feedback`,
`numbers_set_feedback_status` (new → triaged → closed). Reports carry free-text PII, so every one
requires the **app-admin role** on top of the `feedback:*` scope — the same §6.3-style admin read
grant the triage UI uses (invariant 13). The list is lean (no diagnostics); `get` adds the redacted
diagnostics the admin UI shows and — when the reporter attached an **opt-in screenshot** — returns
the image as an **MCP image content block** (the same bytes the admin triage UI serves; never a
disk path, and only through the admin-gated `get`, never the list). `src/lib/mcp/feedback.ts` wraps
the existing `src/lib/feedback/server.ts` service.

**No AI-calling tools.** Draft-building always uses the **`stored`** extract mode
(`src/lib/claims.ts` `ExtractMode`): consume each receipt's background-worker annotation, blank
rows for the not-yet-annotated, **no provider call**. There is no `extractWithAi` option and no
ministry-suggestion tool — the assistant does its own reasoning, so the MCP backend never spends
the deployment's AI quota. (The app's own review UI still offers AI suggestions via the REST
`/api/reimbursements/[id]/suggest` route; that is unchanged and not exposed over MCP.)

**Approval URL.** Every tool that stages or edits a draft a human must approve
(`numbers_create_draft_claim`, `add_receipts_to_claim`, `update_claim_settings`,
`update_line_item`, `draft_catalog_edit`) returns an **`approvalUrl`** alongside its result — the
review page (`/claims/<id>`) or Proposed Changes (`/catalog-drafts`) — so the assistant can hand
the user a direct link. Absolute when `PUBLIC_BASE_URL` is set (or derivable from the request
origin), else root-relative. Built in `src/lib/mcp/auth.ts` (`approvalUrlFor`), which captures the
origin at token-verification time.

### Reusing app logic (no drift)

The write tools call the **same service functions** the API routes call, extracted so there is
one source of truth for the invariant-critical logic (audit trail, embedding enqueues, total
recompute, un-verification, single-ministry fan-out):

- `src/lib/claims.ts` — `createDraftClaim`, `addReceiptsToClaim` (+ receipt resolvers).
- `src/lib/claim-edits.ts` — `updateClaimSettings`, `updateLineItem`, `suggestForClaim`.

The routes (`/api/reimbursements`, `.../[id]`, `.../[id]/receipts`, `.../[id]/suggest`,
`/api/line-items/[id]`) are thin callers of these.

## Catalog edits are drafts a human applies

MCP never mutates ministries/teams/positions directly — those need an elevated role and are
consequential. `numbers_draft_catalog_edit` stages a **`CatalogDraft`** (pending). Both
**proposing and applying** require the **same manage role** the app enforces:

- ministries & positions → `canManageMinistries` (treasurer/admin, active duty).
- teams → `canManageTeams` (approver-or-above, active duty).

A human reviews pending drafts on **Proposed Changes** (`/catalog-drafts`, linked from the
account menu for role-holders) and **Applies** (re-checks the role, performs the targeted
mutation, writes an `apply-catalog-draft` AuditEvent) or **Discards**. Logic in
`src/lib/catalog-drafts.ts`; API under `/api/catalog-drafts`. Membership and holder assignment
are **not** draftable over MCP (they touch other people's data) — only descriptive fields and
budget-category codes are.

**Staleness — field-level 3-way merge.** A draft snapshots the target row's mergeable fields at
stage time (`CatalogDraft.baseJson`). At apply, `threeWayMerge` (pure, unit-tested) compares that
base against the row's **current** state: fields nobody else touched apply; a field this draft and
someone else both changed to different values is a **conflict** (apply 409s with `catalogDraftConflict`
— never a silent clobber); a deleted target 409s with `catalogDraftStale`; team `codes` set-merge
(the draft's adds/removes-vs-base folded onto the current set, so a concurrently-added code
survives). Because the write is a partial update, non-overlapping edits are preserved either way —
the base snapshot is what lets apply *detect* an overlap rather than overwrite it. The Proposed
Changes page shows each update as a proposed-vs-current diff, flags conflicts, and disables Apply
on a stale/conflicting draft (the API is the real gate; the disabled button is cosmetic). This also
makes multiple pending drafts on one row safe: the second to apply conflict-checks against what the
first already wrote.

## Security invariants (must hold)

1. **No secrets over MCP.** Read shapes in `src/lib/mcp/data.ts` are hand-built allowlists —
   never a spread of a Prisma row — so `publicToken`, `signatureLedger*`, `packetSha256`,
   `firebaseUid`, file paths/hashes, and PII (member/holder identities) never leave. Token
   secrets are hashed at rest and shown once. No GET returns a token.
2. **No signing / no consequential writes / no AI spend.** No scope or tool for sign/submit/
   decision/paid/revert/pdf/delete-claim, and MCP never sets `isVerified` — the human-in-the-loop
   gate (invariant 3) stays a human in the app. Catalog edits are staged, applied only by an
   authorized human. No tool calls an LLM (no suggestion tool, no `extractWithAi`), so the backend
   never spends the deployment's provider quota.
3. **Owner-scoped, least privilege.** Every query filters by the token's `userId`; a token
   grants only its chosen scopes; catalog tools additionally require the manage role, so a token
   can never exceed what its owner could do in the app. The two deliberate cross-tenant reads are
   the app's own §6.3 grants, mirrored: catalog tools (manage role) and **feedback tools
   (app-admin role)** — feedback carries free-text PII, so those tools are admin-gated on top of
   the scope, matching the admin triage UI. Still no secrets (invariant 1): feedback returns the
   reporter's name/email, redacted diagnostics, and the report's opt-in screenshot (the same content
   the admin UI already exposes) — never tokens, keys, or another surface's data.
4. **Invariant parity.** Because the write tools reuse the app's service functions, the audit
   (invariant 7), embedding (invariant 11), money-in-cents (invariant 1), un-verification
   (invariant 4), and total-recompute (invariant 5) trails stay complete.

## Connecting an assistant

1. Profile → **AI assistant connections** → create a connection, choose scopes, copy the token
   (shown once).
2. In Claude (custom connector) or ChatGPT (developer-mode app), add the endpoint URL
   (`https://<host>/api/mcp`) and paste the token as the bearer credential.

## Files

- Endpoint `src/app/api/[transport]/route.ts`; server/tools `src/lib/mcp/server.ts`;
  auth `src/lib/mcp/auth.ts`; tokens `src/lib/mcp/tokens.ts`; scopes `src/lib/mcp/scopes.ts`;
  read DTOs `src/lib/mcp/data.ts`.
- Token API `src/app/api/mcp-tokens/**`; connections UI `src/components/mcp/ConnectionsCard.tsx`.
- Catalog drafts lib `src/lib/catalog-drafts.ts`; API `src/app/api/catalog-drafts/**`;
  review page `src/app/catalog-drafts/page.tsx` + `src/components/mcp/CatalogDraftsReview.tsx`.
- Models `McpToken`, `CatalogDraft` in `prisma/schema.prisma`.
- Strings under `Connections.*` / `CatalogDrafts.*` / `NavBar.proposedChanges` / new `Errors.*`
  in `messages/*.json` (invariant 10).

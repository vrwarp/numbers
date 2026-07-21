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
- `runtime="nodejs"`, `maxDuration=300` (draft help defaults to a no-AI path; `extractWithAi`
  can sit through provider quota cooldowns).

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
submit/approval/pdf scope by design.

| scope | grants |
|---|---|
| `receipts:read` | list/read own receipts (sanitized) |
| `claims:read` | list/read own claims + status |
| `claims:draft` | create/edit **draft** claims |
| `ai:suggest` | AI ministry suggestions (uses the user's provider quota) |
| `catalog:read` | list ministries/teams/positions (**also** needs the manage role) |
| `catalog:draft` | stage catalog edits as drafts (**also** needs the manage role) |

Enforcement is **per tool** inside the callback (`requireScope`); an ungranted scope returns a
clear, actionable tool error (PAT has no OAuth step-up).

## Tools (`src/lib/mcp/server.ts`)

Small, task-oriented surface (kept well under the context-bloat threshold), each annotated
(`readOnlyHint`/`destructiveHint`/`openWorldHint`). Money crosses the LLM boundary as **dollars**
and converts via `src/lib/money.ts` (invariant 1); outputs carry both cents and a decimal string.

**Read:** `numbers_list_receipts`, `numbers_get_receipt`, `numbers_list_claims`,
`numbers_get_claim` (with a `verification` summary of what still blocks the human gate),
`numbers_list_ministries`.

**Draft help (write, bounded to `status:"draft"`, reusing the app's own service logic so all
invariants hold):** `numbers_create_draft_claim`, `numbers_add_receipts_to_claim`,
`numbers_update_claim_settings`, `numbers_update_line_item` (**cannot** set `isVerified`),
`numbers_suggest_ministry`.

**Catalog (list + draft edits):** `numbers_list_teams`, `numbers_list_positions`,
`numbers_draft_catalog_edit`, `numbers_list_catalog_drafts`, `numbers_discard_catalog_draft`.

Draft-help drafting defaults to the **`stored`** extract mode (`src/lib/claims.ts` `ExtractMode`):
consume each receipt's background-worker annotation, blank rows for the not-yet-annotated, **no
provider call** — fast, no surprise quota. `extractWithAi:true` opts into inline AI extraction.

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

## Security invariants (must hold)

1. **No secrets over MCP.** Read shapes in `src/lib/mcp/data.ts` are hand-built allowlists —
   never a spread of a Prisma row — so `publicToken`, `signatureLedger*`, `packetSha256`,
   `firebaseUid`, file paths/hashes, and PII (member/holder identities) never leave. Token
   secrets are hashed at rest and shown once. No GET returns a token.
2. **No signing / no consequential writes.** No scope or tool for sign/submit/decision/paid/
   revert/pdf/delete-claim, and MCP never sets `isVerified` — the human-in-the-loop gate
   (invariant 3) stays a human in the app. Catalog edits are staged, applied only by an
   authorized human.
3. **Owner-scoped, least privilege.** Every query filters by the token's `userId`; a token
   grants only its chosen scopes; catalog tools additionally require the manage role, so a token
   can never exceed what its owner could do in the app.
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

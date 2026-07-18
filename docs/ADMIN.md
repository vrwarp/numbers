# Admin interface

A single admin-only area (`/admin`, 404 for everyone else) that lets whoever
administers a deployment do the jobs that previously required shell access to
the `/data` volume — chiefly editing the **church context** document fed to the
ministry-suggestion AI, plus configuring the app, watching usage, reading the
audit/extraction trail, and reviewing the e-sign roster (the vouch-for chain).

Admin = the verified roster role `User.role === "admin"` (the root is always
admin — see `docs/ESIGN_DESIGN.md §5.5`) **OR** a `ADMIN_EMAILS` address
(`isAppAdmin` in `src/lib/config.ts`). The area gates like every other
cross-tenant surface: **404, never 403** (`requireAdmin` in
`src/lib/admin/guard.ts`).

### Seeding the first admin

The roster role is only granted by a signature-verified `GRANT_ROLE` event —
signed by the root or an attested executive officer (chairman/secretary/
treasurer) or admin (A11; the `admin` role itself is root-only) — so a
brand-new deployment has no admin until the e-sign root bootstraps. To seed an
admin immediately — before, or instead of, standing up e-signatures — set
`ADMIN_EMAILS` (comma/space-separated) in the environment or `config.json`.
It is an **app-surface** grant: it opens the `/admin` area and the e-sign
app-surface toggles (master switch, rollout allowlist) but is *never* written
into `User.role`, so the roster's cryptographic truth and signing validity are
untouched. `ADMIN_EMAILS` is itself editable under Admin → Settings, so once one
admin is in, the rest can be managed in-app.

## Why this shape — the ideation ↔ admin-critique loop

The brief asked for the church-context editor plus "a more comprehensive admin
interface", and explicitly for five rounds of *ideation → admin-user critique*
to find what a church admin actually needs day-to-day / week-to-week /
month-to-month. The distilled result:

**Round 1.** *Ideas:* edit the context file; see extraction failures; see stuck
claims; see quota problems; weekly usage counts; who's active; pending
vouches/device requests; monthly roster & role review; config drift.
*Admin critique:* "I'm a volunteer, not IT. Don't give me a wall of JSON — if I
fat-finger it, does the app die? The context editor is what I touch most: make
it dead simple and show me what the AI actually sees. I don't know what
`AI_RPM_TARGET` means. Don't print my API keys on screen. The 'vouch chain' —
if someone can't sign, I need to see *why* and *what to do*."

**Round 2.** *Ideas:* context editor with a live 16 KB counter, a "this is sent
to the AI provider" privacy note, an example scaffold; a **grouped form** for
config (plain labels, masked secrets, validation) instead of raw JSON; a
"problems" panel with actionable red/amber items; honest usage counts; a
filterable log; a roster/vouch view. *Admin critique:* "Better. But the real
vouch-chain data needs the ledger key that only enrolled devices hold — for the
day-to-day list use the server's *verified mirror* (who's attested, what role),
not the crypto. Don't fabricate dollar 'spend' — I don't have per-model pricing.
Don't let me edit keys that would brick auth (`AUTH_SECRET`, `DATABASE_URL`,
`DATA_DIR`). And tell me when something needs attention without me logging in
every day."

**Round 3.** *Ideas:* two-level roster view — a mirror-backed **Members** table
for the daily job, and the full cryptographic chain (rendered client-side for
the enrolled admin) one tap away; server-computed health checks; honest counts
plus *real* money from `paid` claims (`totalCents`, never invented); a config
**allowlist** of editable keys with secrets write-only and bootstrap keys
hidden. *Admin critique:* "'Attention without logging in' means email — too
heavy for now; a Problems card I see on landing is enough. If I also edit the
file by hand, last-write-wins is fine but *show me the file path*. And put the
context editor first — it's the whole reason I'm here."

**Round 4.** *Ideas:* one tabbed `/admin` — **Overview** (problems + headline
stats, the landing), **Church Context** (tab 1 proper, the editor), **Settings**
(grouped config), **Usage** (counts + a small time chart + real paid totals),
**Logs** (audit + extraction errors, *defaulting to problems*), **Members**
(mirror table + e-sign master switch/scope + allowlist + the vouch chain).
*Admin critique:* "Right shape. Two things: default the log filter to errors,
and don't make the *whole* area depend on e-sign being on — context, settings,
and usage must work with e-sign off; only Members needs it."

**Round 5.** *Ideas:* ship exactly that; reuse the app's conventions
(`handleApi`/`requireUserId`, the `card`/`btn-*` classes, next-intl, the
`AuditEvent` trail); every mutation audited; all strings localized. *Admin
critique:* "Ship it — just keep money in cents, don't invent spend, make the
context save hot-reload (it already reads fresh), and only show me the /admin
link if I'm actually an admin."

## Layout

`/admin` → `AdminDashboard` with six tabs:

| Tab | Purpose | Cadence |
| :-- | :-- | :-- |
| Overview | Health/"problems" cards + headline counts | every visit |
| Church Context | Markdown editor for the suggestion context (**the main job**) | as vocabulary changes |
| Settings | Grouped, guard-railed editor for `config.json` env overrides | rare / setup |
| Usage | Totals, claims by status, AI-call success/failure over time | weekly |
| Logs | Audit events + extraction failures, filterable (errors by default) | when troubleshooting |
| Members | Verified-mirror member table + e-sign switch/scope/allowlist + vouch chain | monthly |

## API (`src/app/api/admin/*`, all `requireAdmin` + audited on write)

- `GET /api/admin/overview` — health checks + headline stats.
- `GET /api/admin/church-context` / `PUT` — read/save the context doc (16 KB
  cap, `AuditEvent(admin-church-context)`); hot-reloaded (`loadChurchContext`
  reads fresh).
- `GET /api/admin/config` / `PATCH` — allowlisted keys only; secrets are
  write-only (returned as `set: true/false`, never echoed); `PATCH` merges into
  `<DATA_DIR>/config.json` and audits a redacted diff.
- `GET /api/admin/logs` — recent audit events + extraction errors.
- `GET /api/admin/members` — verified-mirror users (role, enrollment, allowlist,
  activity counts).

The e-sign master switch/scope reuses the existing `PATCH /api/esign/registry`;
the rollout allowlist reuses `PATCH /api/esign/allowlist`. The vouch chain is
rendered client-side via `loadRoster()` (the admin is the enrolled root).

The Members tab stays the read-only monthly-review mirror; the management
actions (role grants, key revocation, allowlist grants) live on the Members
page (`/members`, treasurer/admin-gated like Budget Categories and Positions),
which the tab links to.

## Guard-rails

`ADMIN_CONFIG_FIELDS` (`src/lib/admin/config-schema.ts`) is the *only* set of
keys the UI can read or write. Bootstrap / auth-critical / test-only keys
(`DATABASE_URL`, `DATA_DIR`, `AUTH_SECRET`, `AI_MOCK`, `AUTH_TEST_MODE`,
`ESIGN_MOCK`, `CHURCH_CONTEXT_PATH`, emulator hosts, …) are deliberately absent,
so no admin can lock the deployment out of its own database or session secret
through the UI. Secrets never leave the server; numbers/enums are validated
before the file is written.
</content>
</invoke>

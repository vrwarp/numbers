/**
 * Index diagnostics against the seeded perf database: EXPLAIN QUERY PLAN plus
 * a timed run for the queries that sit on hot paths. A line reading
 * "SCAN <Table>" (rather than SEARCH … USING INDEX) is a full-table scan —
 * fine at seed scale, linear in table size in production.
 *
 *   node scripts/perf/explain.mjs
 */
import { PrismaClient } from "@prisma/client";

const dbPath = process.env.PERF_DB || `${process.cwd()}/.perf-data/perf.db`;
const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });

const QUERIES = [
  {
    name: "finance queue (approved|paid, ordered)",
    sql: `SELECT id FROM Reimbursement WHERE status IN ('approved','paid') ORDER BY status, decidedAt DESC`,
  },
  {
    name: "notification worker: count approved",
    sql: `SELECT COUNT(*) c FROM Reimbursement WHERE status = 'approved'`,
  },
  {
    name: "team grant: line items by ministry code",
    sql: `SELECT li.receiptId FROM LineItem li JOIN Reimbursement r ON r.id = li.reimbursementId
          WHERE li.isExcluded = 0 AND r.status != 'draft' AND li.ministry LIKE '470 %'`,
  },
  {
    name: "shoebox list (userId, ordered by createdAt)",
    sql: `SELECT id FROM Receipt WHERE userId = (SELECT id FROM User LIMIT 1) ORDER BY createdAt DESC`,
  },
  {
    name: "admin logs: distinct audit actions",
    sql: `SELECT DISTINCT action FROM AuditEvent ORDER BY action ASC`,
  },
  {
    name: "admin overview: extraction logs in last 30d",
    sql: `SELECT status, kind FROM ExtractionLog WHERE createdAt >= datetime('now','-30 day')`,
  },
  {
    name: "approvals inbox (approverUserId, ordered by submittedAt)",
    sql: `SELECT id FROM Reimbursement WHERE approverUserId IS NOT NULL
          AND status IN ('submitted','approved','rejected','paid') ORDER BY submittedAt DESC`,
  },
  {
    name: "signer identities by status",
    sql: `SELECT id FROM SignerIdentity WHERE status = 'attested'`,
  },
];

for (const q of QUERIES) {
  const plan = await prisma.$queryRawUnsafe(`EXPLAIN QUERY PLAN ${q.sql}`);
  const detail = plan.map((p) => p.detail).join(" | ");
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) await prisma.$queryRawUnsafe(q.sql);
  const ms = (performance.now() - t0) / 20;
  const scans = /\bSCAN\b/.test(detail) ? "FULL SCAN" : "indexed ";
  console.log(`${scans}  ${ms.toFixed(2).padStart(6)}ms  ${q.name}\n            ${detail}`);
}

const counts = await prisma.$queryRawUnsafe(
  `SELECT (SELECT COUNT(*) FROM Receipt) receipts, (SELECT COUNT(*) FROM Reimbursement) claims,
          (SELECT COUNT(*) FROM LineItem) lineItems, (SELECT COUNT(*) FROM AuditEvent) audit,
          (SELECT COUNT(*) FROM ExtractionLog) logs`
);
console.log("\ntable sizes:", counts[0]);
await prisma.$disconnect();

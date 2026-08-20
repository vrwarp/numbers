/**
 * Do the hot-path full-table scans actually matter? Blow a throwaway copy of
 * the schema up to a decade of church use, time the queries, add the candidate
 * indexes, and time them again. Prints the before/after so an index is only
 * added when it earns it.
 *
 *   node scripts/perf/index-scale.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const RECEIPTS = 50_000; // ~50 members × 100 receipts/yr × 10 yr
const CLAIMS = 5_000;
const LINE_ITEMS = 20_000;
const AUDIT = 60_000;
const LOGS = 150_000; // one per AI call AND one per search (kind="embedding")
const IDENTITIES = 200;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "numbers-scale-"));
const dbPath = path.join(dir, "scale.db");
execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
  stdio: "pipe",
});
const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });

console.log(`seeding ${RECEIPTS} receipts / ${CLAIMS} claims / ${LOGS} logs …`);
const STATUSES = ["draft", "generated", "submitted", "approved", "paid", "rejected"];
await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL"); // returns a row → queryRaw
await prisma.$executeRawUnsafe(`
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${Math.max(RECEIPTS, LOGS)})
  INSERT INTO User (id, email, role, esignAllowed, approvalsPaused, financePaused, adminPaused,
    locale, printIncludeReceipts, printIncludeCertificate, notifyEnabled, notifySigning,
    notifyClaimProgress, notifyFinance, notifySecurity, notifyDiscreet, notifyUiStateJson,
    esignNudgesJson, prefersPaper, createdAt)
  SELECT 'u'||i, 'user'||i||'@example.com', 'member', 0,0,0,0,'en',0,0,0,1,1,1,1,0,'{}','{}',0,datetime('now')
  FROM n WHERE i <= 50`);
// Separate owners for the SignerIdentity rows (userId is unique, FK-enforced).
await prisma.$executeRawUnsafe(`
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${IDENTITIES})
  INSERT INTO User (id, email, role, esignAllowed, approvalsPaused, financePaused, adminPaused,
    locale, printIncludeReceipts, printIncludeCertificate, notifyEnabled, notifySigning,
    notifyClaimProgress, notifyFinance, notifySecurity, notifyDiscreet, notifyUiStateJson,
    esignNudgesJson, prefersPaper, createdAt)
  SELECT 'su'||i, 'signer'||i||'@example.com', 'approver', 0,0,0,0,'en',0,0,0,1,1,1,1,0,'{}','{}',0,datetime('now')
  FROM n`);
await prisma.$executeRawUnsafe(`
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${RECEIPTS})
  INSERT INTO Receipt (id, userId, filePath, mimeType, originalName, sizeBytes, status, note,
    merchant, purchaseDate, extractedSummary, annotationSource, fileSha256, createdAt)
  SELECT 'r'||i, 'u'||(i%50+1), 'uploads/x/'||i||'.webp', 'image/webp', 'IMG'||i||'.jpg', 100000,
    CASE WHEN i%3=0 THEN 'processed' ELSE 'unassigned' END, '', 'Merchant'||(i%20),
    '2026-01-01', 'stuff', 'ai', 'sha'||i, datetime('now', '-'||(i%3650)||' day') FROM n`);
await prisma.$executeRawUnsafe(`
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${CLAIMS})
  INSERT INTO Reimbursement (id, userId, status, totalCents, singleMinistry, claimMinistry,
    claimEvent, claimDescription, submitSeq, pendingActionsJson, checkNumber, createdAt, updatedAt,
    approverUserId, submittedAt, decidedAt)
  SELECT 'c'||i, 'u'||(i%50+1), '${STATUSES[0]}', 1000, 1, '', '', 'claim '||i, 0, '{}', '',
    datetime('now'), datetime('now'), 'u'||(i%50+1), datetime('now','-'||(i%1000)||' day'),
    datetime('now','-'||(i%1000)||' day') FROM n`);
// Spread the statuses so the queue queries see realistic selectivity.
for (let s = 1; s < STATUSES.length; s++) {
  await prisma.$executeRawUnsafe(
    `UPDATE Reimbursement SET status = '${STATUSES[s]}' WHERE CAST(substr(id,2) AS INTEGER) % ${STATUSES.length} = ${s}`
  );
}
await prisma.$executeRawUnsafe(`
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${LINE_ITEMS})
  INSERT INTO LineItem (id, reimbursementId, receiptId, description, amountCents, ministry, event,
    isVerified, isExcluded, sortOrder)
  SELECT 'li'||i, 'c'||(i%${CLAIMS}+1), 'r'||(i%${RECEIPTS}+1), 'desc '||i, 1000,
    (200 + i%300)||' Category', '', 1, CASE WHEN i%20=0 THEN 1 ELSE 0 END, i%13 FROM n`);
await prisma.$executeRawUnsafe(`
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${AUDIT})
  INSERT INTO AuditEvent (id, userId, reimbursementId, action, detail, createdAt)
  SELECT 'a'||i, 'u'||(i%50+1), 'c'||(i%${CLAIMS}+1),
    CASE i%6 WHEN 0 THEN 'update' WHEN 1 THEN 'split' WHEN 2 THEN 'merge'
             WHEN 3 THEN 'add-receipt' WHEN 4 THEN 'manual-entry' ELSE 'revert-to-draft' END,
    '{}', datetime('now','-'||(i%3650)||' day') FROM n`);
await prisma.$executeRawUnsafe(`
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${LOGS})
  INSERT INTO ExtractionLog (id, userId, kind, model, prompt, status, durationMs, createdAt)
  SELECT 'l'||i, 'u'||(i%50+1), CASE WHEN i%2=0 THEN 'embedding' ELSE 'receipt' END, 'm', 'p',
    CASE WHEN i%50=0 THEN 'error' ELSE 'success' END, 100,
    datetime('now','-'||(i%3650)||' day') FROM n`);
await prisma.$executeRawUnsafe(`
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${IDENTITIES})
  INSERT INTO SignerIdentity (id, userId, publicKey, signatureImage, status, createdAt)
  SELECT 'si'||i, 'su'||i, 'k', '', CASE WHEN i%3=0 THEN 'attested' ELSE 'pending' END,
    datetime('now') FROM n`);
await prisma.$executeRawUnsafe("ANALYZE");

const ONE_USER = "u1";
const QUERIES = [
  {
    name: "shoebox list (userId + createdAt DESC)",
    sql: `SELECT id FROM Receipt WHERE userId = '${ONE_USER}' ORDER BY createdAt DESC`,
  },
  {
    name: "finance queue (status IN, ordered)",
    sql: `SELECT id FROM Reimbursement WHERE status IN ('approved','paid') ORDER BY status, decidedAt DESC`,
  },
  {
    name: "notify worker: COUNT approved",
    sql: `SELECT COUNT(*) c FROM Reimbursement WHERE status = 'approved'`,
  },
  {
    name: "approvals inbox (approver + submittedAt DESC)",
    sql: `SELECT id FROM Reimbursement WHERE approverUserId = '${ONE_USER}'
          AND status IN ('submitted','approved','rejected','paid') ORDER BY submittedAt DESC`,
  },
  {
    name: "team grant: line items by ministry code",
    sql: `SELECT li.receiptId FROM LineItem li JOIN Reimbursement r ON r.id = li.reimbursementId
          WHERE li.isExcluded = 0 AND r.status != 'draft' AND li.ministry LIKE '470 %'`,
  },
  {
    name: "admin logs: DISTINCT audit actions",
    sql: `SELECT DISTINCT action FROM AuditEvent ORDER BY action ASC`,
  },
  {
    name: "admin overview: logs in last 30d",
    sql: `SELECT status, kind FROM ExtractionLog WHERE createdAt >= datetime('now','-30 day')`,
  },
  {
    name: "signer identities by status",
    sql: `SELECT id FROM SignerIdentity WHERE status = 'attested'`,
  },
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS Receipt_userId_createdAt_idx ON Receipt(userId, createdAt)`,
  `CREATE INDEX IF NOT EXISTS Reimbursement_status_idx ON Reimbursement(status)`,
  `CREATE INDEX IF NOT EXISTS Reimbursement_approverUserId_submittedAt_idx ON Reimbursement(approverUserId, submittedAt)`,
  `CREATE INDEX IF NOT EXISTS LineItem_ministry_idx ON LineItem(ministry)`,
  `CREATE INDEX IF NOT EXISTS AuditEvent_action_idx ON AuditEvent(action)`,
  `CREATE INDEX IF NOT EXISTS ExtractionLog_createdAt_idx ON ExtractionLog(createdAt)`,
  `CREATE INDEX IF NOT EXISTS SignerIdentity_status_idx ON SignerIdentity(status)`,
];

async function timeAll(label) {
  const out = [];
  for (const q of QUERIES) {
    await prisma.$queryRawUnsafe(q.sql); // warm
    const t0 = performance.now();
    const reps = 10;
    for (let i = 0; i < reps; i++) await prisma.$queryRawUnsafe(q.sql);
    const ms = (performance.now() - t0) / reps;
    const plan = await prisma.$queryRawUnsafe(`EXPLAIN QUERY PLAN ${q.sql}`);
    const detail = plan.map((p) => p.detail).join(" | ");
    out.push({ name: q.name, ms, scan: /\bSCAN\b/.test(detail), detail });
  }
  console.log(`\n--- ${label} ---`);
  for (const r of out) {
    console.log(`${(r.scan ? "SCAN" : "idx ").padEnd(5)} ${r.ms.toFixed(2).padStart(8)}ms  ${r.name}`);
  }
  return out;
}

const before = await timeAll("BEFORE (current schema indexes)");
for (const sql of INDEXES) await prisma.$executeRawUnsafe(sql);
await prisma.$executeRawUnsafe("ANALYZE");
const after = await timeAll("AFTER (candidate indexes added)");

console.log("\n--- verdict ---");
for (let i = 0; i < before.length; i++) {
  const b = before[i].ms;
  const a = after[i].ms;
  const factor = b / a;
  const verdict = factor >= 2 && b - a > 1 ? "KEEP  " : "no gain";
  console.log(
    `${verdict} ${b.toFixed(2).padStart(8)}ms → ${a.toFixed(2).padStart(8)}ms  (${factor.toFixed(1)}×)  ${before[i].name}`
  );
}

await prisma.$disconnect();
fs.rmSync(dir, { recursive: true, force: true });

process.on("unhandledRejection", (err) => {
  console.error("index-scale failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

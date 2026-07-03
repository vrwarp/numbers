-- AlterTable
ALTER TABLE "LineItem" ADD COLUMN "originalAmountCents" INTEGER;
ALTER TABLE "LineItem" ADD COLUMN "originalDescription" TEXT;
ALTER TABLE "LineItem" ADD COLUMN "originalMinistry" TEXT;
ALTER TABLE "LineItem" ADD COLUMN "originalQuantity" REAL;

-- CreateTable
CREATE TABLE "ExtractionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "reimbursementId" TEXT,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "receiptsJson" TEXT NOT NULL,
    "rawResponse" TEXT,
    "parsedJson" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExtractionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExtractionLog_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "Reimbursement" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "reimbursementId" TEXT,
    "lineItemId" TEXT,
    "action" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "Reimbursement" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ExtractionLog_userId_createdAt_idx" ON "ExtractionLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ExtractionLog_reimbursementId_idx" ON "ExtractionLog"("reimbursementId");

-- CreateIndex
CREATE INDEX "AuditEvent_reimbursementId_idx" ON "AuditEvent"("reimbursementId");

-- CreateIndex
CREATE INDEX "AuditEvent_userId_createdAt_idx" ON "AuditEvent"("userId", "createdAt");

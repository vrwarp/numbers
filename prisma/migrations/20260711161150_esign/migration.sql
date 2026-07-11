-- CreateTable
CREATE TABLE "EsignRegistry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rosterLedgerId" TEXT NOT NULL,
    "rosterLedgerKey" TEXT NOT NULL,
    "rootPublicKey" TEXT NOT NULL,
    "rootUserId" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL DEFAULT 'ueta-v1',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SignerIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attestedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignerIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LedgerEventMirror" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ledgerId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAtMs" BIGINT NOT NULL,
    "encryptedData" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT '',
    "verifiedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SignatureRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reimbursementId" TEXT,
    "kind" TEXT NOT NULL,
    "signerUserId" TEXT NOT NULL,
    "signerPublicKey" TEXT NOT NULL,
    "typedName" TEXT NOT NULL DEFAULT '',
    "packetSha256" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "actionHash" TEXT NOT NULL,
    "ledgerEventId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignatureRecord_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "Reimbursement" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EsignClaimArchive" (
    "claimId" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "ledgerKey" TEXT NOT NULL,
    "publicToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EsignMockEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ledgerId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "encryptedData" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Reimbursement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "singleMinistry" BOOLEAN NOT NULL DEFAULT true,
    "claimMinistry" TEXT NOT NULL DEFAULT '',
    "claimEvent" TEXT NOT NULL DEFAULT '',
    "claimDescription" TEXT NOT NULL DEFAULT '',
    "publicToken" TEXT,
    "approverUserId" TEXT,
    "signatureLedgerId" TEXT,
    "signatureLedgerKey" TEXT,
    "packetSha256" TEXT,
    "submitSeq" INTEGER NOT NULL DEFAULT 0,
    "pendingActionsJson" TEXT NOT NULL DEFAULT '{}',
    "submittedAt" DATETIME,
    "decidedAt" DATETIME,
    "paidAt" DATETIME,
    "checkNumber" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Reimbursement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Reimbursement" ("claimDescription", "claimEvent", "claimMinistry", "createdAt", "id", "publicToken", "singleMinistry", "status", "totalCents", "updatedAt", "userId") SELECT "claimDescription", "claimEvent", "claimMinistry", "createdAt", "id", "publicToken", "singleMinistry", "status", "totalCents", "updatedAt", "userId" FROM "Reimbursement";
DROP TABLE "Reimbursement";
ALTER TABLE "new_Reimbursement" RENAME TO "Reimbursement";
CREATE UNIQUE INDEX "Reimbursement_publicToken_key" ON "Reimbursement"("publicToken");
CREATE INDEX "Reimbursement_userId_status_idx" ON "Reimbursement"("userId", "status");
CREATE INDEX "Reimbursement_approverUserId_status_idx" ON "Reimbursement"("approverUserId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SignerIdentity_userId_key" ON "SignerIdentity"("userId");

-- CreateIndex
CREATE INDEX "LedgerEventMirror_ledgerId_idx" ON "LedgerEventMirror"("ledgerId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEventMirror_ledgerId_eventId_key" ON "LedgerEventMirror"("ledgerId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "SignatureRecord_actionHash_key" ON "SignatureRecord"("actionHash");

-- CreateIndex
CREATE INDEX "SignatureRecord_reimbursementId_idx" ON "SignatureRecord"("reimbursementId");

-- CreateIndex
CREATE INDEX "EsignClaimArchive_publicToken_idx" ON "EsignClaimArchive"("publicToken");

-- CreateIndex
CREATE INDEX "EsignMockEvent_ledgerId_id_idx" ON "EsignMockEvent"("ledgerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EsignMockEvent_ledgerId_eventId_key" ON "EsignMockEvent"("ledgerId", "eventId");

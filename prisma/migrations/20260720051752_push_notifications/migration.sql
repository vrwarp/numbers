-- CreateTable
CREATE TABLE "PushToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSendOkAt" DATETIME,
    CONSTRAINT "PushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotificationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "targetId" TEXT NOT NULL DEFAULT '',
    "dedupeKey" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" DATETIME,
    "lastError" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "firebaseUid" TEXT,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "mailingAddress" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "esignAllowed" BOOLEAN NOT NULL DEFAULT false,
    "approvalsPaused" BOOLEAN NOT NULL DEFAULT false,
    "financePaused" BOOLEAN NOT NULL DEFAULT false,
    "adminPaused" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "printIncludeReceipts" BOOLEAN NOT NULL DEFAULT false,
    "printIncludeCertificate" BOOLEAN NOT NULL DEFAULT false,
    "notifyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "notifySigning" BOOLEAN NOT NULL DEFAULT true,
    "notifyClaimProgress" BOOLEAN NOT NULL DEFAULT true,
    "notifyFinance" BOOLEAN NOT NULL DEFAULT true,
    "notifySecurity" BOOLEAN NOT NULL DEFAULT true,
    "notifyDiscreet" BOOLEAN NOT NULL DEFAULT false,
    "notifyUiStateJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("adminPaused", "approvalsPaused", "createdAt", "email", "esignAllowed", "financePaused", "firebaseUid", "fullName", "id", "locale", "mailingAddress", "printIncludeCertificate", "printIncludeReceipts", "role") SELECT "adminPaused", "approvalsPaused", "createdAt", "email", "esignAllowed", "financePaused", "firebaseUid", "fullName", "id", "locale", "mailingAddress", "printIncludeCertificate", "printIncludeReceipts", "role" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PushToken_token_key" ON "PushToken"("token");

-- CreateIndex
CREATE INDEX "PushToken_userId_idx" ON "PushToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationJob_dedupeKey_key" ON "NotificationJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationJob_status_nextAttemptAt_idx" ON "NotificationJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationJob_userId_createdAt_idx" ON "NotificationJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationJob_targetId_idx" ON "NotificationJob"("targetId");

-- AlterTable
ALTER TABLE "Reimbursement" ADD COLUMN "generatedAt" DATETIME;

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
    "esignNudgesJson" TEXT NOT NULL DEFAULT '{}',
    "prefersPaper" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("adminPaused", "approvalsPaused", "createdAt", "email", "esignAllowed", "financePaused", "firebaseUid", "fullName", "id", "locale", "mailingAddress", "printIncludeCertificate", "printIncludeReceipts", "role") SELECT "adminPaused", "approvalsPaused", "createdAt", "email", "esignAllowed", "financePaused", "firebaseUid", "fullName", "id", "locale", "mailingAddress", "printIncludeCertificate", "printIncludeReceipts", "role" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

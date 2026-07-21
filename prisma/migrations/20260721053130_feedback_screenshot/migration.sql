-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FeedbackReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'bug',
    "situation" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL DEFAULT '',
    "route" TEXT NOT NULL DEFAULT '',
    "buildSha" TEXT NOT NULL DEFAULT '',
    "diagnosticsJson" TEXT NOT NULL DEFAULT '{}',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "screenshotPath" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedbackReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_FeedbackReport" ("buildSha", "category", "createdAt", "diagnosticsJson", "id", "locale", "message", "route", "situation", "status", "userAgent", "userId") SELECT "buildSha", "category", "createdAt", "diagnosticsJson", "id", "locale", "message", "route", "situation", "status", "userAgent", "userId" FROM "FeedbackReport";
DROP TABLE "FeedbackReport";
ALTER TABLE "new_FeedbackReport" RENAME TO "FeedbackReport";
CREATE INDEX "FeedbackReport_userId_createdAt_idx" ON "FeedbackReport"("userId", "createdAt");
CREATE INDEX "FeedbackReport_status_createdAt_idx" ON "FeedbackReport"("status", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

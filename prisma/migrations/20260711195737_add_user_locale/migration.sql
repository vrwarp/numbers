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
    "locale" TEXT NOT NULL DEFAULT 'en',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("createdAt", "email", "firebaseUid", "fullName", "id", "mailingAddress", "role") SELECT "createdAt", "email", "firebaseUid", "fullName", "id", "mailingAddress", "role" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

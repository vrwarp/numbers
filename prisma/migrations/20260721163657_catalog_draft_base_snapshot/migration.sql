-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CatalogDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "targetId" TEXT,
    "proposedJson" TEXT NOT NULL DEFAULT '{}',
    "baseJson" TEXT NOT NULL DEFAULT '{}',
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolvedById" TEXT,
    CONSTRAINT "CatalogDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CatalogDraft" ("createdAt", "entity", "id", "note", "operation", "proposedJson", "resolvedAt", "resolvedById", "status", "targetId", "userId") SELECT "createdAt", "entity", "id", "note", "operation", "proposedJson", "resolvedAt", "resolvedById", "status", "targetId", "userId" FROM "CatalogDraft";
DROP TABLE "CatalogDraft";
ALTER TABLE "new_CatalogDraft" RENAME TO "CatalogDraft";
CREATE INDEX "CatalogDraft_entity_status_idx" ON "CatalogDraft"("entity", "status");
CREATE INDEX "CatalogDraft_userId_idx" ON "CatalogDraft"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

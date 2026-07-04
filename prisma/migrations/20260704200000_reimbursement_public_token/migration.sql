-- AlterTable
ALTER TABLE "Reimbursement" ADD COLUMN "publicToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Reimbursement_publicToken_key" ON "Reimbursement"("publicToken");


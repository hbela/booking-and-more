-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'PROVIDER_INVITED';

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "provider_id" TEXT;

-- CreateIndex
CREATE INDEX "invitations_provider_id_idx" ON "invitations"("provider_id");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

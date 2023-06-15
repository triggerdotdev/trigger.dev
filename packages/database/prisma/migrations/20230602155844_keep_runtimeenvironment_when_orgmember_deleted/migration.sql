-- DropForeignKey
ALTER TABLE "RuntimeEnvironment" DROP CONSTRAINT "RuntimeEnvironment_orgMemberId_fkey";

-- AddForeignKey
ALTER TABLE "RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_orgMemberId_fkey" FOREIGN KEY ("orgMemberId") REFERENCES "OrgMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

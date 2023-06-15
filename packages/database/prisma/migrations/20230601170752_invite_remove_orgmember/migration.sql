/*
  Warnings:

  - You are about to drop the column `memberId` on the `OrgMemberInvite` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "OrgMemberInvite" DROP CONSTRAINT "OrgMemberInvite_memberId_fkey";

-- DropIndex
DROP INDEX "OrgMemberInvite_memberId_key";

-- AlterTable
ALTER TABLE "OrgMemberInvite" DROP COLUMN "memberId";

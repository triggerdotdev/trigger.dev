/*
  Warnings:

  - A unique constraint covering the columns `[organizationId,email]` on the table `OrgMemberInvite` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "OrgMemberInvite_organizationId_email_key" ON "OrgMemberInvite"("organizationId", "email");

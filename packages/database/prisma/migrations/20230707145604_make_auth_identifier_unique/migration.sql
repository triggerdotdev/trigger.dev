/*
  Warnings:

  - A unique constraint covering the columns `[authIdentifier]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "User_authIdentifier_key" ON "User"("authIdentifier");

/*
  Warnings:

  - A unique constraint covering the columns `[key]` on the table `SecretReference` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "SecretReference_key_key" ON "SecretReference"("key");

/*
  Warnings:

  - You are about to drop the `ExternalAccount` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Integration` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `IntegrationAuthMethod` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `IntegrationDefinition` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE IF EXISTS "ExternalAccount" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "Integration" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "IntegrationAuthMethod" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "IntegrationDefinition" CASCADE;

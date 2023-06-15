/*
  Warnings:

  - The values [ENDPOINT_INITIATED] on the enum `EndpointIndexSource` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "EndpointIndexSource_new" AS ENUM ('MANUAL', 'INTERNAL', 'HOOK');
ALTER TABLE "EndpointIndex" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "EndpointIndex" ALTER COLUMN "source" TYPE "EndpointIndexSource_new" USING ("source"::text::"EndpointIndexSource_new");
ALTER TYPE "EndpointIndexSource" RENAME TO "EndpointIndexSource_old";
ALTER TYPE "EndpointIndexSource_new" RENAME TO "EndpointIndexSource";
DROP TYPE "EndpointIndexSource_old";
ALTER TABLE "EndpointIndex" ALTER COLUMN "source" SET DEFAULT 'MANUAL';
COMMIT;

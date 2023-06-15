-- AlterTable
ALTER TABLE "IntegrationResponse" RENAME COLUMN "body" to "output";
ALTER TABLE "IntegrationResponse" ADD COLUMN "context" JSONB;

UPDATE "IntegrationResponse" SET context = jsonb_build_object('headers', headers, 'statusCode', '200');
ALTER TABLE "IntegrationResponse" ALTER COLUMN "context" SET NOT NULL;

ALTER TABLE "IntegrationResponse" DROP COLUMN "headers", DROP COLUMN "statusCode";

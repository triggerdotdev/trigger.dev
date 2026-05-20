-- AlterTable: make ownerId nullable to match ON DELETE SET NULL foreign key
ALTER TABLE "public"."MetricsDashboard" ALTER COLUMN "ownerId" DROP NOT NULL;

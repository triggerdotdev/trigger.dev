-- AlterTable
ALTER TABLE "RuntimeEnvironment" ADD COLUMN "title" TEXT;

-- If the slug is "dev" set the title to "Development"
UPDATE "RuntimeEnvironment" SET "title" = 'Development' WHERE "slug" = 'dev';
-- If the slug is "prod" set the title to "Production"
UPDATE "RuntimeEnvironment" SET "title" = 'Production' WHERE "slug" = 'prod';

-- Make the title column not null
ALTER TABLE "RuntimeEnvironment" ALTER COLUMN     "title" SET NOT NULL;

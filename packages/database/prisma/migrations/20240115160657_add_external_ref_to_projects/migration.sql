ALTER TABLE
  "Project"
ADD
  COLUMN "externalRef" TEXT;

-- Populate the externalRef column
UPDATE
  "Project"
SET
  "externalRef" = MD5(RANDOM() :: text);

-- Make the externalRef column non-nullable
ALTER TABLE
  "Project"
ALTER COLUMN
  "externalRef"
SET
  NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Project_externalRef_key" ON "Project"("externalRef");
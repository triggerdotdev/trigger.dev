## Creating and applying migrations

We use prisma migrations to manage the database schema. Please follow the following steps when editing the `internal-packages/database/prisma/schema.prisma` file:

Edit the `schema.prisma` file to add or modify the schema.

Create a new migration file but don't apply it yet:

```bash
cd internal-packages/database
pnpm run db:migrate:dev:create --name "add_new_column_to_table"
```

The migration file will be created in the `prisma/migrations` directory, but it will have a bunch of edits to the schema that are not needed and will need to be removed before we can apply the migration. Here's an example of what the migration file might look like:

```sql
-- AlterEnum
ALTER TYPE "public"."TaskRunExecutionStatus" ADD VALUE 'DELAYED';

-- AlterTable
ALTER TABLE "public"."TaskRun" ADD COLUMN     "debounce" JSONB;

-- AlterTable
ALTER TABLE "public"."_BackgroundWorkerToBackgroundWorkerFile" ADD CONSTRAINT "_BackgroundWorkerToBackgroundWorkerFile_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_BackgroundWorkerToBackgroundWorkerFile_AB_unique";

-- AlterTable
ALTER TABLE "public"."_BackgroundWorkerToTaskQueue" ADD CONSTRAINT "_BackgroundWorkerToTaskQueue_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_BackgroundWorkerToTaskQueue_AB_unique";

-- AlterTable
ALTER TABLE "public"."_TaskRunToTaskRunTag" ADD CONSTRAINT "_TaskRunToTaskRunTag_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_TaskRunToTaskRunTag_AB_unique";

-- AlterTable
ALTER TABLE "public"."_WaitpointRunConnections" ADD CONSTRAINT "_WaitpointRunConnections_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_WaitpointRunConnections_AB_unique";

-- AlterTable
ALTER TABLE "public"."_completedWaitpoints" ADD CONSTRAINT "_completedWaitpoints_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_completedWaitpoints_AB_unique";

-- CreateIndex
CREATE INDEX "SecretStore_key_idx" ON "public"."SecretStore"("key" text_pattern_ops);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_id_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "id" DESC);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_createdAt_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "createdAt" DESC);
```

All the following lines should be removed:

```sql
-- AlterTable
ALTER TABLE "public"."_BackgroundWorkerToBackgroundWorkerFile" ADD CONSTRAINT "_BackgroundWorkerToBackgroundWorkerFile_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_BackgroundWorkerToBackgroundWorkerFile_AB_unique";

-- AlterTable
ALTER TABLE "public"."_BackgroundWorkerToTaskQueue" ADD CONSTRAINT "_BackgroundWorkerToTaskQueue_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_BackgroundWorkerToTaskQueue_AB_unique";

-- AlterTable
ALTER TABLE "public"."_TaskRunToTaskRunTag" ADD CONSTRAINT "_TaskRunToTaskRunTag_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_TaskRunToTaskRunTag_AB_unique";

-- AlterTable
ALTER TABLE "public"."_WaitpointRunConnections" ADD CONSTRAINT "_WaitpointRunConnections_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_WaitpointRunConnections_AB_unique";

-- AlterTable
ALTER TABLE "public"."_completedWaitpoints" ADD CONSTRAINT "_completedWaitpoints_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_completedWaitpoints_AB_unique";

-- CreateIndex
CREATE INDEX "SecretStore_key_idx" ON "public"."SecretStore"("key" text_pattern_ops);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_id_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "id" DESC);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_createdAt_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "createdAt" DESC);
```

Leaving only this:

```sql
-- AlterEnum
ALTER TYPE "public"."TaskRunExecutionStatus" ADD VALUE 'DELAYED';

-- AlterTable
ALTER TABLE "public"."TaskRun" ADD COLUMN     "debounce" JSONB;
```

After editing the migration file, apply the migration:

```bash
cd internal-packages/database
pnpm run db:migrate:deploy && pnpm run generate
```

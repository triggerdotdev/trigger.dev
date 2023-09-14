-- AlterTable
ALTER TABLE "BackgroundTaskMachinePool" ADD COLUMN     "diskSize" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "BackgroundTaskVersion" ADD COLUMN     "diskSize" INTEGER NOT NULL DEFAULT 1;

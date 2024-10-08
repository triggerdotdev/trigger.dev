-- AlterTable
ALTER TABLE "TaskEvent" ADD COLUMN     "machinePreset" TEXT,
ADD COLUMN     "machinePresetCentsPerMs" DOUBLE PRECISION,
ADD COLUMN     "machinePresetCpu" DOUBLE PRECISION,
ADD COLUMN     "machinePresetMemory" DOUBLE PRECISION;

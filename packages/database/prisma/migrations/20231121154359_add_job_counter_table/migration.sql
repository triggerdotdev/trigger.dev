-- CreateTable
CREATE TABLE "JobCounter" (
    "jobId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "JobCounter_pkey" PRIMARY KEY ("jobId")
);

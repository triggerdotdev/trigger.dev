-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WaitpointResolver') THEN
        CREATE TYPE "WaitpointResolver" AS ENUM ('ENGINE', 'TOKEN', 'HTTP_CALLBACK');
    END IF;
END$$;

-- AlterTable
ALTER TABLE "Waitpoint"
ADD COLUMN IF NOT EXISTS "resolver" "WaitpointResolver" NOT NULL DEFAULT 'ENGINE';
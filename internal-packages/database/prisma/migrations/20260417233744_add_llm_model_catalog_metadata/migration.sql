-- AlterTable
ALTER TABLE "public"."llm_models" ADD COLUMN     "deprecation_date" TIMESTAMP(3),
ADD COLUMN     "knowledge_cutoff" TIMESTAMP(3),
ADD COLUMN     "needs_review" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "release_date" TIMESTAMP(3),
ADD COLUMN     "resolved_at" TIMESTAMP(3),
ADD COLUMN     "supports_parallel_tool_calls" BOOLEAN,
ADD COLUMN     "supports_streaming_tool_calls" BOOLEAN,
ADD COLUMN     "supports_structured_output" BOOLEAN;

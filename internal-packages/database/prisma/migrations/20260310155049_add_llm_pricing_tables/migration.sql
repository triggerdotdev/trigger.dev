-- CreateTable
CREATE TABLE "public"."llm_models" (
    "id" TEXT NOT NULL,
    "project_id" TEXT,
    "model_name" TEXT NOT NULL,
    "match_pattern" TEXT NOT NULL,
    "start_date" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'default',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."llm_pricing_tiers" (
    "id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "conditions" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "llm_pricing_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."llm_prices" (
    "id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "pricing_tier_id" TEXT NOT NULL,
    "usage_type" TEXT NOT NULL,
    "price" DECIMAL(20,12) NOT NULL,

    CONSTRAINT "llm_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_models_project_id_idx" ON "public"."llm_models"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "llm_models_project_id_model_name_start_date_key" ON "public"."llm_models"("project_id", "model_name", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX "llm_pricing_tiers_model_id_priority_key" ON "public"."llm_pricing_tiers"("model_id", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "llm_pricing_tiers_model_id_name_key" ON "public"."llm_pricing_tiers"("model_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "llm_prices_model_id_usage_type_pricing_tier_id_key" ON "public"."llm_prices"("model_id", "usage_type", "pricing_tier_id");

-- AddForeignKey
ALTER TABLE "public"."llm_models" ADD CONSTRAINT "llm_models_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."llm_pricing_tiers" ADD CONSTRAINT "llm_pricing_tiers_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "public"."llm_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."llm_prices" ADD CONSTRAINT "llm_prices_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "public"."llm_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."llm_prices" ADD CONSTRAINT "llm_prices_pricing_tier_id_fkey" FOREIGN KEY ("pricing_tier_id") REFERENCES "public"."llm_pricing_tiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

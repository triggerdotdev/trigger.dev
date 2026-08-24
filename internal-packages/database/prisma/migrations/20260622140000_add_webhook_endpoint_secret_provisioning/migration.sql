-- Who supplies the signing secret/key for a webhook endpoint ("provider" | "integrator" | "either").
-- Drives the dashboard Connect UI (paste vs generate). Synced from the declared source.
ALTER TABLE "WebhookEndpoint" ADD COLUMN "secretProvisioning" TEXT NOT NULL DEFAULT 'either';

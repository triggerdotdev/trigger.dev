import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { handleInternalWebhookTest } from "~/utils/internalWebhookTester.server";

export async function action({ request }: ActionFunctionArgs) {
  return handleInternalWebhookTest(request, {
    nodeEnv: env.NODE_ENV,
    webhookSecret: process.env.INTERNAL_TEST_WEBHOOK_SECRET,
    logger,
  });
}

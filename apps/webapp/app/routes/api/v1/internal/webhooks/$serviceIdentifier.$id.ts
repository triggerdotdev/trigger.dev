import type { ActionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { findRegisteredWebhookById } from "~/models/registeredWebhook.server";
import { HandleWebhook } from "~/services/webhooks/handleWebhook.server";

export async function action({ request, params }: ActionArgs) {
  const { id, serviceIdentifier } = z
    .object({ id: z.string(), serviceIdentifier: z.string() })
    .parse(params);

  const webhook = await findRegisteredWebhookById(id);

  if (!webhook) {
    return {
      status: 404,
      body: `Could not find webhook with id ${id} and serviceIdentifier ${serviceIdentifier}`,
    };
  }

  if (webhook.connectionSlot.connection?.apiIdentifier !== serviceIdentifier) {
    return { status: 500, body: "Service identifier does not match" };
  }

  try {
    const handleWebhookService = new HandleWebhook();

    await handleWebhookService.call(webhook, serviceIdentifier, request);

    return { status: 200 };
  } catch (error) {
    return {
      status: 500,
      body: error instanceof Error ? error.message : `Unknown error: ${error}`,
    };
  }
}

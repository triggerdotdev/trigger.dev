import type { ActionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { findExternalSourceById } from "~/models/externalSource.server";
import { IngestEvent } from "~/services/events/ingest.server";

const paramsSchema = z.object({
  externalSourceId: z.string(),
});

const bodySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  event: z.string(),
  input: z.record(z.any()),
  displayProperties: z.object({
    title: z.string(),
  }),
  payload: z.any(),
});

export async function action({ request, params }: ActionArgs) {
  const { externalSourceId } = paramsSchema.parse(params);
  const body = await request.json();
  const { id, timestamp, event, displayProperties, payload } =
    bodySchema.parse(body);

  const externalSource = await findExternalSourceById(externalSourceId);

  if (!externalSource || externalSource.type !== "INTEGRATION_WEBHOOK") {
    return {
      status: 404,
      body: `Could not find external source with id ${externalSourceId}`,
    };
  }

  try {
    const ingestService = new IngestEvent();
    await ingestService.call(
      {
        id,
        payload,
        name: event,
        type: "INTEGRATION_WEBHOOK",
        service: externalSource.service,
        timestamp,
        context: {},
        displayProperties,
      },
      externalSource.organization
    );

    return { status: 200 };
  } catch (error) {
    return {
      status: 500,
      body:
        error instanceof Error
          ? error.message
          : `Unknown error: ${JSON.stringify(error)}`,
    };
  }
}

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { HandleHttpSourceService } from "~/services/sources/handleHttpSource.server";

export async function action({ request, params }: ActionFunctionArgs) {
  logger.info("Handling http source", { url: request.url });

  try {
    const { id } = z.object({ id: z.string() }).parse(params);
    const service = new HandleHttpSourceService();
    const result = await service.call(id, request);

    return new Response(undefined, {
      status: result.status,
    });
  } catch (e) {
    if (e instanceof Error) {
      logger.error("Error handling http source", { error: e.message });
    } else {
      logger.error("Error handling http source", { error: JSON.stringify(e) });
    }
    return new Response(undefined, {
      status: 500,
    });
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  logger.info("Handling http source", { url: request.url });

  const { id } = z.object({ id: z.string() }).parse(params);

  const service = new HandleHttpSourceService();

  return await service.call(id, request);
}

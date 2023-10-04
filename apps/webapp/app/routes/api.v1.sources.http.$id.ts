import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { HandleHttpSourceService } from "~/services/sources/handleHttpSource.server";

export async function action({ request, params }: ActionFunctionArgs) {
  logger.info("Handling http source", { url: request.url });

  const { id } = z.object({ id: z.string() }).parse(params);

  const service = new HandleHttpSourceService();

  return await service.call(id, request);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  logger.info("Handling http source", { url: request.url });

  const { id } = z.object({ id: z.string() }).parse(params);

  const service = new HandleHttpSourceService();

  return await service.call(id, request);
}

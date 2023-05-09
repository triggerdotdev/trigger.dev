import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { logger } from "~/services/logger";
import { HandleHttpSourceService } from "~/services/sources/handleHttpSource.server";

export async function action({ request, params }: ActionArgs) {
  logger.info("Handling http source", { url: request.url });

  const { id } = z.object({ id: z.string() }).parse(params);

  const service = new HandleHttpSourceService();

  return await service.call(id, request);
}

export async function loader({ request, params }: LoaderArgs) {
  logger.info("Handling http source", { url: request.url });

  const { id } = z.object({ id: z.string() }).parse(params);

  const service = new HandleHttpSourceService();

  return await service.call(id, request);
}

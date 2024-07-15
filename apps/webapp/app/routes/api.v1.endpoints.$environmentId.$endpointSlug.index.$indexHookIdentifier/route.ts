import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { safeJsonParse } from "~/utils/json";
import { TriggerEndpointIndexHookService } from "./TriggerEndpointIndexHookService.server";

export const ParamsSchema = z.object({
  environmentId: z.string(),
  endpointSlug: z.string(),
  indexHookIdentifier: z.string(),
});

export async function loader({ params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return {
      status: 400,
      json: {
        error: "Invalid params",
      },
    };
  }

  const { environmentId, endpointSlug, indexHookIdentifier } = parsedParams.data;

  const service = new TriggerEndpointIndexHookService();

  await service.call({
    environmentId,
    endpointSlug,
    indexHookIdentifier,
  });

  return json({
    ok: true,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return {
      status: 400,
      json: {
        error: "Invalid params",
      },
    };
  }

  const { environmentId, endpointSlug, indexHookIdentifier } = parsedParams.data;

  const body = await request.text();

  const service = new TriggerEndpointIndexHookService();

  await service.call({
    environmentId,
    endpointSlug,
    indexHookIdentifier,
    body: body ? safeJsonParse(body) : undefined,
  });

  return json({
    ok: true,
  });
}

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  HandleHttpEndpointService,
  HttpEndpointParamsSchema,
} from "~/services/httpendpoint/HandleHttpEndpointService.server";
import { logger } from "~/services/logger.server";

export async function action({ request, params }: ActionFunctionArgs) {
  logger.info("Handling httpendpoint (action)", { url: request.url, method: request.method });

  try {
    const parsedParams = HttpEndpointParamsSchema.parse(params);
    const service = new HandleHttpEndpointService();
    const response = await service.call(parsedParams, request);
    logger.info("Handled httpendpoint (action)", {
      url: request.url,
      method: request.method,
      response,
    });
    return response;
  } catch (e) {
    if (e instanceof Error) {
      logger.error("Error handling http endpoint", { error: e.message });
    } else {
      logger.error("Error handling http endpoint", { error: JSON.stringify(e) });
    }
    return new Response(undefined, {
      status: 500,
    });
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  logger.info("Handling httpendpoint (loader)", { url: request.url, method: request.method });

  try {
    const parsedParams = HttpEndpointParamsSchema.parse(params);
    const service = new HandleHttpEndpointService();
    const response = await service.call(parsedParams, request);
    logger.info("Handled httpendpoint (loader)", {
      url: request.url,
      method: request.method,
      response,
    });
    return response;
  } catch (e) {
    if (e instanceof Error) {
      logger.error("Error handling http endpoint", { error: e.message });
    } else {
      logger.error("Error handling http endpoint", { error: JSON.stringify(e) });
    }
    return new Response(undefined, {
      status: 500,
    });
  }
}

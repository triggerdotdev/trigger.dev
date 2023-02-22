import { AuthCredentials } from "core/authentication/types";
import { HTTPMethodSchema } from "core/endpoint/types";
import { serviceFetch } from "core/fetch/serviceFetch";
import { Request, Response } from "express";
import { catalog } from "integrations/catalog";
import { z } from "zod";
import { error } from "./requestUtilities";

const requestBodySchema = z.object({
  credentials: z.object({ accessToken: z.string() }).optional(),
  path: z.string(),
  method: HTTPMethodSchema,
  headers: z.record(z.string(), z.string()).optional(),
  body: z.any(),
});

type ReturnResponse = {
  response: NormalizedResponse;
  isRetryable: boolean;
  ok: boolean;
};

type NormalizedResponse = {
  output: NonNullable<any>;
  context: any;
};

export async function handleAction(req: Request, res: Response) {
  const { service } = req.params;

  const matchingService = Object.values(catalog.services).find(
    (s) => s.service === service
  );

  if (!matchingService) {
    return {
      success: false,
      error: { type: "missing_service", message: "Service not found", service },
    };
  }

  const parsedRequestBody = requestBodySchema.safeParse(req.body);

  if (!parsedRequestBody.success) {
    res.status(400).send(
      JSON.stringify(
        error(400, false, {
          type: "invalid_body",
          message: "Invalid input",
          issues: parsedRequestBody.error.issues,
        })
      )
    );
    return;
  }

  //v1 build credentials from the service authentication info
  let credentials: AuthCredentials | undefined = undefined;
  if (parsedRequestBody.data.credentials) {
    //just get the first security method
    const [name, securityMethod] = Object.entries(
      matchingService.authentication
    )[0];

    switch (securityMethod.type) {
      case "oauth2":
        credentials = {
          type: "oauth2",
          name,
          accessToken: parsedRequestBody.data.credentials.accessToken,
          scopes: Object.keys(securityMethod.scopes),
        };
        break;
      case "api_key":
        credentials = {
          type: "api_key",
          name,
          api_key: parsedRequestBody.data.credentials.accessToken,
          scopes: Object.keys(securityMethod.scopes),
        };
        break;
      default:
        throw new Error(
          `Not implemented credentials for: ${JSON.stringify(securityMethod)}`
        );
    }
  }

  const url = matchingService.baseUrl + parsedRequestBody.data.path;

  const data = await serviceFetch({
    url,
    method: parsedRequestBody.data.method,
    headers: parsedRequestBody.data.headers,
    body: parsedRequestBody.data.body,
    authentication: matchingService.authentication,
    credentials,
  });

  const response: ReturnResponse = {
    ok: true,
    isRetryable: isRetryable(data.status),
    response: {
      output: data.body ?? {},
      context: {
        statusCode: data.status,
        headers: data.headers,
      },
    },
  };
  res.send(JSON.stringify(response));
}

function isRetryable(statusCode: number) {
  return [408, 429, 500, 502, 503, 504].includes(statusCode);
}

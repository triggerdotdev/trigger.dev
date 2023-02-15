import { PostgresCacheService } from "cache/postgresCache";
import { AuthCredentials } from "core/authentication/types";
import { Service } from "core/service/types";
import { validateInputs } from "core/validation/inputs";
import { Request, Response } from "express";
import { catalog } from "integrations/catalog";
import { z } from "zod";
import { createParametersBody } from "./createParametersBody";
import { getServiceAction } from "./validation";

const requestBodySchema = z.object({
  credentials: z.object({ accessToken: z.string() }).optional(),
  params: z.record(z.string().or(z.number()), z.any()).optional(),
  metadata: z.object({
    requestId: z.string(),
    workflowId: z.string(),
    connectionId: z.string(),
  }),
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
  const serviceActionResult = getServiceAction(req.params);

  if (!serviceActionResult.success) {
    res
      .status(404)
      .send(JSON.stringify(error(404, false, serviceActionResult.error)));
    return;
  }

  const { service, action } = serviceActionResult;

  const parsedRequestBody = requestBodySchema.safeParse(req.body);

  if (!parsedRequestBody.success) {
    res.status(400).send(
      JSON.stringify(
        error(400, false, {
          type: "invalid_body",
          message: "Action not found",
          service,
          action,
          issues: parsedRequestBody.error.issues,
        })
      )
    );
    return;
  }

  //for v1 of this API we're building the credentials from the action
  //this is fine for now but we'll want to use the connection in future to cover complex cases
  let credentials: AuthCredentials | undefined = undefined;
  if (parsedRequestBody.data.credentials && action.spec.input.security) {
    const firstSecurityMethod = Object.entries(action.spec.input.security)[0];
    if (firstSecurityMethod) {
      const [name, scopes] = firstSecurityMethod;
      //get the full info from the service
      const securityMethod = service.authentication[name];

      switch (securityMethod.type) {
        case "oauth2":
          credentials = {
            type: "oauth2",
            name,
            accessToken: parsedRequestBody.data.credentials.accessToken,
            scopes,
          };
          break;
        default:
          throw new Error(`Not implemented ${securityMethod.type}`);
      }
    }
  }

  const { parameters, body } = createParametersBody(
    action.spec.input,
    parsedRequestBody.data.params
  );

  const inputValidationResult = await validateInputs(action.spec.input, {
    parameters,
    body,
    credentials,
  });
  if (!inputValidationResult.success) {
    res
      .status(400)
      .send(JSON.stringify(error(400, false, inputValidationResult.error)));
    return;
  }

  const { metadata } = parsedRequestBody.data;
  const cache = new PostgresCacheService(`${metadata.connectionId}-${service}`);

  try {
    const data = await action.action(
      { credentials, parameters, body },
      cache,
      metadata
    );

    //convert into the format for the webapp
    const response: ReturnResponse = {
      ok: true,
      isRetryable: isRetryable(service, data.status),
      response: {
        output: data.body ?? {},
        context: {
          statusCode: data.status,
          headers: data.headers,
        },
      },
    };
    res.send(JSON.stringify(response));
  } catch (e: any) {
    console.error(e);

    if (e instanceof Error) {
      res
        .status(500)
        .send(JSON.stringify(error(500, false, { error: JSON.stringify(e) })));
      return;
    }

    if ("error" in e) {
      res.status(500).send(JSON.stringify(error(500, false, e.error)));
      return;
    }

    res
      .status(500)
      .send(JSON.stringify(error(500, false, { error: JSON.stringify(e) })));
  }
}

function isRetryable(service: Service, status: number): boolean {
  return service.retryableStatusCodes.includes(status);
}

function error(
  status: number,
  isRetryable: boolean,
  error: Record<string, any>
): ReturnResponse {
  const response: ReturnResponse = {
    ok: false,
    isRetryable,
    response: {
      output: error,
      context: {
        statusCode: status,
        headers: {},
      },
    },
  };
  return response;
}

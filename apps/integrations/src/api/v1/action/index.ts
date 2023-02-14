import { PostgresCacheService } from "cache/postgresCache";
import { AuthCredentials } from "core/authentication/types";
import { Service } from "core/service/types";
import { validateInputs } from "core/validation/inputs";
import { Request, Response } from "express";
import { catalog } from "integrations/catalog";
import { z } from "zod";

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
  const { service, action } = req.params;

  const matchingService = Object.values(catalog.services).find(
    (s) => s.service === service
  );

  if (!matchingService) {
    res.status(404).send(
      JSON.stringify(
        error(404, false, {
          type: "missing_service",
          message: "Service not found",
          service,
        })
      )
    );
    return;
  }

  const matchingAction = Object.values(matchingService.actions).find(
    (a) => a.name === action
  );

  if (!matchingAction) {
    res.status(404).send(
      JSON.stringify(
        error(404, false, {
          type: "missing_action",
          message: "Action not found",
          service,
          action,
        })
      )
    );
    return;
  }

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
  if (
    parsedRequestBody.data.credentials &&
    matchingAction.spec.input.security
  ) {
    const firstSecurityMethod = Object.entries(
      matchingAction.spec.input.security
    )[0];
    if (firstSecurityMethod) {
      const [name, scopes] = firstSecurityMethod;
      //get the full info from the service
      const securityMethod = matchingService.authentication[name];

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

  //separate the parameters and body by looking at the spec and pulling properties out
  let parameters: Record<string, any> | undefined = undefined;
  let body: any = undefined;

  if (parsedRequestBody.data.params) {
    matchingAction.spec.input.parameters?.forEach((p) => {
      if (!parameters) {
        parameters = {};
      }
      parameters[p.name] = parsedRequestBody.data.params?.[p.name];
    });

    const bodyProperties = matchingAction.spec.input.body?.properties;
    if (bodyProperties) {
      body = {};
      Object.keys(bodyProperties).forEach((name) => {
        const value = parsedRequestBody.data.params?.[name];
        if (value !== undefined) {
          body[name] = value;
        }
      });
    }
  }

  console.log("parameters", parameters);
  console.log("body", body);

  const inputValidationResult = await validateInputs(
    matchingAction.spec.input,
    {
      parameters,
      body,
      credentials,
    }
  );
  if (!inputValidationResult.success) {
    res
      .status(400)
      .send(JSON.stringify(error(400, false, inputValidationResult.error)));
    return;
  }

  const { metadata } = parsedRequestBody.data;
  const cache = new PostgresCacheService(
    `${metadata.connectionId}-${metadata.workflowId}`
  );

  try {
    const data = await matchingAction.action(
      { credentials, parameters, body },
      cache,
      metadata
    );

    //convert into the format for the webapp
    const response: ReturnResponse = {
      ok: true,
      isRetryable: isRetryable(matchingService, data.status),
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

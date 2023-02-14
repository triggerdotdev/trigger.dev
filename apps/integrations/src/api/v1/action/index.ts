import { PostgresCacheService } from "cache/postgresCache";
import { AuthCredentials } from "core/authentication/types";
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

export async function handleAction(req: Request, res: Response) {
  const { service, action } = req.params;

  const matchingService = Object.values(catalog.services).find(
    (s) => s.service === service
  );

  if (!matchingService) {
    res.status(404).send(
      JSON.stringify({
        success: false,
        service,
        error: { type: "missing_service", message: "Service not found" },
      })
    );
    return;
  }

  const matchingAction = Object.values(matchingService.actions).find(
    (a) => a.name === action
  );

  if (!matchingAction) {
    res.status(404).send(
      JSON.stringify({
        success: false,
        service,
        action,
        error: { type: "missing_action", message: "Action not found" },
      })
    );
    return;
  }

  const parsedRequestBody = requestBodySchema.safeParse(req.body);

  if (!parsedRequestBody.success) {
    res.status(400).send(
      JSON.stringify({
        success: false,
        error: { type: "invalid_body", issues: parsedRequestBody.error.issues },
      })
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
    res.status(400).send(
      JSON.stringify({
        success: false,
        error: inputValidationResult.error,
      })
    );
    return;
  }

  const { metadata } = parsedRequestBody.data;
  const cache = new PostgresCacheService(metadata.connectionId);

  try {
    const data = await matchingAction.action(
      { credentials, parameters, body },
      cache,
      metadata
    );
    res.send(JSON.stringify(data));
  } catch (e: any) {
    console.error(e);
    res
      .status(500)
      .send(JSON.stringify({ success: false, errors: e.toString() }));
  }
}

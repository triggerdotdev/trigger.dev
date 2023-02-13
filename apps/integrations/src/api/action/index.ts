import { AuthCredentialsSchema } from "core/authentication/types";
import { Request, Response } from "express";
import { catalog } from "integrations/catalog";
import { z } from "zod";

const bodySchema = z.object({
  parameters: z.record(z.string(), z.any()).optional(),
  credentials: AuthCredentialsSchema.optional(),
  body: z.any().optional(),
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

  console.log("body", req.body);

  const bodyResult = bodySchema.safeParse(req.body);

  if (!bodyResult.success) {
    res.status(400).send(
      JSON.stringify({
        success: false,
        error: { type: "invalid_body", issues: bodyResult.error.issues },
      })
    );
    return;
  }

  try {
    const data = await matchingAction.action(bodyResult.data);
    res.send(JSON.stringify(data));
  } catch (e: any) {
    res
      .status(500)
      .send(JSON.stringify({ success: false, errors: e.toString() }));
  }
}

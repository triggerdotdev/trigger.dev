import { DisplayProperties } from "core/action/types";
import { Request, Response } from "express";
import { catalog } from "integrations/catalog";
import { z } from "zod";
import { createParametersBody } from "./createParametersBody";
import { getServiceAction } from "./validation";

const requestBodySchema = z.object({
  params: z.record(z.string().or(z.number()), z.any()).optional(),
});

export async function handleActionDisplay(req: Request, res: Response) {
  const serviceActionResult = getServiceAction(req.params);

  if (!serviceActionResult.success) {
    res
      .status(404)
      .send(
        JSON.stringify({ success: false, error: serviceActionResult.error })
      );
    return;
  }

  const { service, action } = serviceActionResult;

  const parsedRequestBody = requestBodySchema.safeParse(req.body);
  if (!parsedRequestBody.success) {
    res.status(400).send(
      JSON.stringify({
        success: false,
        error: {
          type: "invalid_body",
          message: "Action not found",
          service,
          action,
          issues: parsedRequestBody.error.issues,
        },
      })
    );
    return;
  }

  const requestData = createParametersBody(
    action.spec.input,
    parsedRequestBody.data.params
  );

  const displayProperties = await action.displayProperties(requestData);
  res.send(JSON.stringify({ success: true, properties: displayProperties }));
}

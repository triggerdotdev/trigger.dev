import { Request, Response } from "express";
import {
  SubscribeInputSchema,
  SubscribeResult,
} from "core/webhook/subscribe/types";
import { SubscribeToWebhook } from "core/webhook/subscribe";

export async function handleCreateWebhook(req: Request, res: Response) {
  const parsedBody = SubscribeInputSchema.safeParse(req.body);

  if (!parsedBody.success) {
    const badBodyResponse: SubscribeResult = {
      success: false,
      error: {
        code: "bad_body",
        message: parsedBody.error.toString(),
      },
    };
    res.status(400).json(badBodyResponse);
    return;
  }

  try {
    const subscribeToWebhook = new SubscribeToWebhook();
    const result = await subscribeToWebhook.call(parsedBody.data);

    if (result.success) {
      res.status(201).json(result);
      return;
    }

    res.status(400).send(result);
    return;
  } catch (error) {
    res.status(500).json(error);
  }
}

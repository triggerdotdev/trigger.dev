import { Request, Response } from "express";
import {
  SubscribeInputSchema,
  SubscribeResult,
} from "core/webhook/subscribe/types";

export async function handleReceivingWebhook(req: Request, res: Response) {
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
}

import { Request, Response } from "express";
import {
  SubscribeInputSchema,
  SubscribeResult,
} from "core/webhook/subscribe/types";
import { SubscribeToWebhook } from "core/webhook/subscribe";
import { Prisma } from "db/db.server";

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

    res.status(400).json(result);
    return;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        res.status(400).json({
          success: false,
          error: {
            code: "duplicate_webhook",
            message: `A webhook with this ${error.meta?.target} already exists`,
          },
        });
        return;
      }
    }

    res.status(500).json(error);
  }
}

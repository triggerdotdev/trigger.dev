import { createDeliveriesAndTasks } from "core/jobs/tasks/webhookJob";
import { HTTPMethod } from "core/request/types";
import { ReceiveWebhook } from "core/webhook/receive";
import {
  WebhookIncomingRequest,
  WebhookReceiveRequest,
} from "core/webhook/types";
import { Request, Response } from "express";

export async function handleReceivingWebhook(req: Request, res: Response) {
  const { webhookId } = req.params;

  if (!webhookId) {
    res.status(400).json({ success: false, error: "Missing webhook ID" });
    return;
  }

  const headers = Object.entries(req.headers)
    .filter(([key, value]) => value !== undefined)
    .reduce((acc, [key, value]) => {
      acc[key] =
        typeof value === "string" ? (value as string) : value?.join(", ") ?? "";
      return acc;
    }, {} as Record<string, string>);

  const request: WebhookIncomingRequest = {
    method: req.method as HTTPMethod,
    searchParams: new URLSearchParams(req.url),
    headers,
    body: req.body,
    rawBody: req.rawBody,
  };

  try {
    const receiver = new ReceiveWebhook();
    const result = await receiver.call({ request, webhookId });

    const response = res.status(result.response.status);
    Object.entries(result.response.headers).forEach(([key, value]) => {
      response.header(key, value);
    });
    response.json(result.response.body);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
}

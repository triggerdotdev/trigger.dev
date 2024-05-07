import { IntegrationTaskKey, Prettify, retry } from "@trigger.dev/sdk";
import type { ResendRunTask } from "./index";
import { Resend } from "resend";
import { handleResendError } from "./utils";

export type SendEmailResult = NonNullable<Awaited<ReturnType<Resend["emails"]["send"]>>["data"]>;
export type CreateEmailResult = NonNullable<
  Awaited<ReturnType<Resend["emails"]["create"]>>["data"]
>;
export type GetEmailResult = NonNullable<Awaited<ReturnType<Resend["emails"]["get"]>>["data"]>;

export class Emails {
  constructor(private runTask: ResendRunTask) {}

  send(
    key: IntegrationTaskKey,
    payload: Parameters<Resend["emails"]["send"]>[0],
    options?: Parameters<Resend["emails"]["send"]>[1]
  ): Promise<SendEmailResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.emails.send(payload, options);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Send Email",
        params: payload,
        properties: [
          {
            label: "From",
            text: payload.from,
          },
          {
            label: "To",
            text: Array.isArray(payload.to) ? payload.to.join(", ") : payload.to,
          },
          ...(payload.subject ? [{ label: "Subject", text: payload.subject }] : []),
        ],
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }

  create(
    key: IntegrationTaskKey,
    payload: Parameters<Resend["emails"]["create"]>[0],
    options?: Parameters<Resend["emails"]["create"]>[1]
  ): Promise<CreateEmailResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.emails.create(payload, options);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Create Email",
        params: payload,
        properties: [
          {
            label: "From",
            text: payload.from,
          },
          {
            label: "To",
            text: Array.isArray(payload.to) ? payload.to.join(", ") : payload.to,
          },
          ...(payload.subject ? [{ label: "Subject", text: payload.subject }] : []),
        ],
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }

  get(key: IntegrationTaskKey, payload: string): Promise<GetEmailResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.emails.get(payload);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Get Email",
        params: payload,
        properties: [
          {
            label: "ID",
            text: payload,
          },
        ],
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }
}

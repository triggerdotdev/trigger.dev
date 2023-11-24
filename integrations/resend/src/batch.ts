import { IntegrationTaskKey, retry } from "@trigger.dev/sdk";
import { Resend } from "resend";
import type { ResendRunTask } from "./index";
import { handleResendError } from "./utils";

type SendEmailResult = NonNullable<Awaited<ReturnType<Resend["batch"]["send"]>>["data"]>;
type CreateEmailResult = NonNullable<Awaited<ReturnType<Resend["batch"]["create"]>>["data"]>;

export class Batch {
  constructor(private runTask: ResendRunTask) {}

  send(
    key: IntegrationTaskKey,
    payload: Parameters<Resend["batch"]["send"]>[0],
    options?: Parameters<Resend["batch"]["send"]>[1]
  ): Promise<SendEmailResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.batch.send(payload, options);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Send Batch Email",
        params: payload,
        properties: [
          {
            label: "Count",
            text: String(payload.length),
          },
        ],
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }

  create(
    key: IntegrationTaskKey,
    payload: Parameters<Resend["batch"]["create"]>[0],
    options?: Parameters<Resend["batch"]["create"]>[1]
  ): Promise<CreateEmailResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.batch.create(payload, options);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Create Batch Email",
        params: payload,
        properties: [
          {
            label: "Count",
            text: String(payload.length),
          },
        ],
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }
}

import { IntegrationTaskKey, retry } from "@trigger.dev/sdk";
import type { ResendRunTask } from "./index";
import { Resend } from "resend";
import { handleResendError } from "./utils";

type CreateAudienceResult = NonNullable<Awaited<ReturnType<Resend["audiences"]["create"]>>["data"]>;
type GetAudienceResult = NonNullable<Awaited<ReturnType<Resend["audiences"]["get"]>>["data"]>;
type DeleteAudienceResult = NonNullable<Awaited<ReturnType<Resend["audiences"]["remove"]>>["data"]>;
type ListAudiencesResult = NonNullable<Awaited<ReturnType<Resend["audiences"]["list"]>>["data"]>;

export class Audiences {
  constructor(private runTask: ResendRunTask) {}

  create(
    key: IntegrationTaskKey,
    payload: Parameters<Resend["audiences"]["create"]>[0],
    options?: Parameters<Resend["audiences"]["create"]>[1]
  ): Promise<CreateAudienceResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.audiences.create(payload, options);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Create Audience",
        params: payload,
        properties: [
          {
            label: "Name",
            text: payload.name,
          },
        ],
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }

  get(key: IntegrationTaskKey, payload: string): Promise<GetAudienceResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.audiences.get(payload);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Get Audience",
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

  remove(key: IntegrationTaskKey, payload: string): Promise<DeleteAudienceResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.audiences.remove(payload);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Remove Audience",
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

  list(key: IntegrationTaskKey): Promise<ListAudiencesResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.audiences.list();

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "List Audiences",
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }
}

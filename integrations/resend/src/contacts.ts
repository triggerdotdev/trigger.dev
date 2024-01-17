import { IntegrationTaskKey, retry } from "@trigger.dev/sdk";
import type { ResendRunTask } from "./index";
import { Resend } from "resend";
import { handleResendError } from "./utils";

type CreateContactResult = NonNullable<Awaited<ReturnType<Resend["contacts"]["create"]>>["data"]>;
type GetContactResult = NonNullable<Awaited<ReturnType<Resend["contacts"]["get"]>>["data"]>;
type UpdateContactResult = NonNullable<Awaited<ReturnType<Resend["contacts"]["update"]>>["data"]>;
type DeleteContactResult = NonNullable<Awaited<ReturnType<Resend["contacts"]["remove"]>>["data"]>;
type ListContactsResult = NonNullable<Awaited<ReturnType<Resend["contacts"]["list"]>>["data"]>;

export class Contacts {
  constructor(private runTask: ResendRunTask) {}

  create(
    key: IntegrationTaskKey,
    payload: Parameters<Resend["contacts"]["create"]>[0],
    options?: Parameters<Resend["contacts"]["create"]>[1]
  ): Promise<CreateContactResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.contacts.create(payload, options);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Create Contact",
        params: payload,
        properties: [
          {
            label: "Email",
            text: payload.email,
          },
          ...(payload.first_name && payload.last_name
            ? [{ label: "Name", text: payload.first_name + " " + payload.last_name }]
            : []),
        ],
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }

  get(
    key: IntegrationTaskKey,
    payload: Parameters<Resend["contacts"]["get"]>[0]
  ): Promise<GetContactResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.contacts.get(payload);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Get Contact",
        params: payload,
        properties: [
          {
            label: "Id",
            text: payload.id,
          },
        ],
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }

  update(
    key: IntegrationTaskKey,
    payload: Parameters<Resend["contacts"]["update"]>[0]
  ): Promise<UpdateContactResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.contacts.update(payload);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Update Contact",
        params: payload,
        properties: [
          {
            label: "Id",
            text: payload.id,
          },
        ],
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }

  remove(
    key: IntegrationTaskKey,
    payload: Parameters<Resend["contacts"]["remove"]>[0]
  ): Promise<DeleteContactResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.contacts.remove(payload);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "Remove Contact",
        params: payload,
        properties: [
          {
            label: "Id",
            text: payload.id,
          },
        ],
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }

  list(
    key: IntegrationTaskKey,
    payload: Parameters<Resend["contacts"]["list"]>[0]
  ): Promise<ListContactsResult> {
    return this.runTask(
      key,
      async (client, task) => {
        const { error, data } = await client.contacts.list(payload);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error("No data returned from Resend");
        }

        return data;
      },
      {
        name: "List Contacts",
        params: payload,
        properties: [
          {
            label: "Audience Id",
            text: payload.audience_id,
          },
        ],
        retry: retry.standardBackoff,
      },
      handleResendError
    );
  }
}

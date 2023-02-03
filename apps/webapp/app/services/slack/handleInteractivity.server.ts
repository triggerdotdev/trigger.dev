import { json } from "@remix-run/server-runtime";
import { schemas } from "@trigger.dev/slack/internal";
import { ulid } from "ulid";
import type { z } from "zod";
import { generateErrorMessage } from "zod-error";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { IngestEvent } from "../events/ingest.server";
import type { OutputUnit } from "@cfworker/json-schema";
import { Validator } from "@cfworker/json-schema";

export class HandleSlackInteractivity {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(payload: unknown) {
    const parsedPayload = schemas.InteractivityPayloadSchema.safeParse(payload);

    if (!parsedPayload.success) {
      console.error(
        "Invalid payload",
        generateErrorMessage(parsedPayload.error.issues)
      );

      return new Response(null, { status: 200 });
    }

    switch (parsedPayload.data.type) {
      case "block_actions":
        return this.#handleBlockActionInteraction(parsedPayload.data);
      case "view_submission":
        return this.#handleViewSubmissionInteraction(parsedPayload.data);
      case "view_closed":
        return this.#handleViewClosedInteraction(parsedPayload.data);
    }
  }

  async #handleBlockActionInteraction(
    payload: z.infer<typeof schemas.BlockActionInteractivityPayloadSchema>
  ) {
    const apiKey = await this.#getApiKeyForBlockActionPayload(payload);

    if (!apiKey) {
      return new Response(null, { status: 200 });
    }

    const ingestService = new IngestEvent();

    await ingestService.call({
      id: ulid(),
      type: "SLACK_INTERACTION",
      name: "block.action",
      service: "slack",
      payload: payload,
      apiKey,
    });

    return new Response(null, { status: 200 });
  }

  async #getApiKeyForBlockActionPayload(
    payload: z.infer<typeof schemas.BlockActionInteractivityPayloadSchema>
  ) {
    if (payload.message) {
      if (!payload.message.metadata) {
        return;
      }

      const parsedPayload =
        schemas.InternalMessageMetadataPayloadSchema.safeParse(
          payload.message.metadata.event_payload
        );

      if (!parsedPayload.success) {
        return;
      }

      const { requestId } = parsedPayload.data.__trigger;

      const integrationRequest =
        await this.#prismaClient.integrationRequest.findUnique({
          where: { id: requestId },
          include: {
            run: {
              include: {
                environment: true,
                workflow: true,
              },
            },
          },
        });

      if (!integrationRequest) {
        return;
      }

      return integrationRequest.run.environment.apiKey;
    } else if (payload.view) {
      if (typeof payload.view.private_metadata !== "string") {
        return;
      }

      const privateMetadataRaw = safeJsonParse(payload.view.private_metadata);

      if (!privateMetadataRaw) {
        return;
      }

      const parsedPrivateMetadata =
        schemas.ViewPrivateMetadataSchema.safeParse(privateMetadataRaw);

      if (!parsedPrivateMetadata.success) {
        console.error(
          "Invalid private metadata",
          generateErrorMessage(parsedPrivateMetadata.error.issues)
        );
        return;
      }

      const runId = parsedPrivateMetadata.data.__trigger.runId;

      const run = await this.#prismaClient.workflowRun.findUnique({
        where: { id: runId },
        include: {
          environment: true,
        },
      });

      if (!run) {
        return;
      }

      return run.environment.apiKey;
    }
  }

  async #handleViewSubmissionInteraction(
    payload: z.infer<typeof schemas.ViewSubmissionInteractivityPayloadSchema>
  ) {
    if (typeof payload.view.private_metadata !== "string") {
      return new Response(null, { status: 200 });
    }

    const privateMetadataRaw = safeJsonParse(payload.view.private_metadata);

    if (!privateMetadataRaw) {
      return new Response(null, { status: 200 });
    }

    const parsedPrivateMetadata =
      schemas.ViewPrivateMetadataSchema.safeParse(privateMetadataRaw);

    if (!parsedPrivateMetadata.success) {
      console.error(
        "Invalid private metadata",
        generateErrorMessage(parsedPrivateMetadata.error.issues)
      );
      return;
    }

    const runId = parsedPrivateMetadata.data.__trigger.runId;

    const run = await this.#prismaClient.workflowRun.findUnique({
      where: { id: runId },
      include: {
        environment: true,
      },
    });

    if (!run) {
      return new Response(null, { status: 200 });
    }

    if (
      parsedPrivateMetadata.data.__trigger.validationSchema &&
      payload.view.state
    ) {
      const validator = new Validator(
        parsedPrivateMetadata.data.__trigger.validationSchema,
        "7",
        false
      );

      const viewData = prepareValidationData(payload.view.state.values);

      console.log("Validating view submission", {
        viewData,
        schema: JSON.stringify(
          parsedPrivateMetadata.data.__trigger.validationSchema
        ),
      });

      const result = validator.validate(viewData);

      if (!result.valid) {
        console.log("view submission validation errors", {
          errors: result.errors,
        });

        const errors = prepareValidationErrors(result.errors);

        console.log("prepared view submission validation errors", {
          errors,
        });

        return json({
          response_action: "errors",
          errors,
        });
      }
    }

    const ingestService = new IngestEvent();

    await ingestService.call({
      id: payload.view.hash,
      type: "SLACK_INTERACTION",
      name: "view.submission",
      service: "slack",
      payload: payload,
      apiKey: run.environment.apiKey,
    });

    return parsedPrivateMetadata.data.__trigger.onSubmit === "clear"
      ? json({ response_action: "clear" })
      : parsedPrivateMetadata.data.__trigger.onSubmit === "close"
      ? new Response(null, { status: 200 })
      : json({ response_action: "none" });
  }

  async #handleViewClosedInteraction(
    payload: z.infer<typeof schemas.ViewClosedInteractivityPayloadSchema>
  ) {
    return new Response(null, { status: 200 });
  }
}

function prepareValidationData(
  values: Record<string, Record<string, any>>
): Record<string, any> {
  const data: Record<string, any> = {};

  Object.keys(values).forEach((blockId) => {
    const actionId = Object.keys(values[blockId])[0];

    if (actionId) {
      const actionData = values[blockId][actionId];

      switch (actionData.type) {
        case "plain_text_input":
          data[blockId] = actionData.value;
          break;
        case "static_select":
          data[blockId] = actionData.selected_option.value;
          break;
        case "external_select":
          data[blockId] = actionData.selected_option.value;
          break;
        case "users_select":
          data[blockId] = actionData.selected_user;
          break;
        case "conversations_select":
          data[blockId] = actionData.selected_conversation;
          break;
        case "channels_select":
          data[blockId] = actionData.selected_channel;
          break;
        case "overflow":
          data[blockId] = actionData.selected_option.value;
          break;
        case "datepicker":
          data[blockId] = actionData.selected_date;
          break;
        case "datetimepicker":
          if (typeof actionData.selected_date_time !== "number") {
            return;
          }

          data[blockId] = new Date(
            actionData.selected_date_time * 1000
          ).toISOString();

          break;
        case "timepicker":
          data[blockId] = actionData.selected_time;
          break;
        case "radio_buttons":
          data[blockId] = actionData.selected_option.value;
          break;
        case "checkboxes":
          data[blockId] = actionData.selected_options.map(
            (option: any) => option.value
          );
          break;
        case "multi_static_select":
          data[blockId] = actionData.selected_options.map(
            (option: any) => option.value
          );
          break;
        case "multi_external_select":
          data[blockId] = actionData.selected_options.map(
            (option: any) => option.value
          );
          break;
        case "multi_users_select":
          data[blockId] = actionData.selected_users;
          break;
        case "multi_conversations_select":
          data[blockId] = actionData.selected_conversations;
          break;
        case "multi_channels_select":
          data[blockId] = actionData.selected_channels;
          break;
        default:
          break;
      }
    }
  });

  return removeUndefinedValues(data);
}

function removeUndefinedValues(obj: Record<string, any>) {
  const newObj: Record<string, any> = {};

  Object.keys(obj).forEach((key) => {
    if (obj[key]) {
      newObj[key] = obj[key];
    }
  });

  return newObj;
}

function prepareValidationErrors(
  outputUnits: OutputUnit[]
): Record<string, string> {
  const errors: Record<string, string> = {};

  outputUnits.forEach((outputUnit) => {
    if (outputUnit.keyword === "required") {
      const blockId = parseBlockIdFromRequiredError(outputUnit.error);

      if (blockId) {
        errors[blockId] = `This field is required`;
      }

      return;
    }

    const blockId = getBlockIdForInstanceLocation(outputUnit.instanceLocation);

    if (!blockId) {
      return;
    }

    errors[blockId] = outputUnit.error;
  });

  return errors;
}

// If instanceLocation is in the form of #/nameField then we should return nameField, but if it's in the form of #/nameField/0 or #/properties/nameField then we should return undefined
function getBlockIdForInstanceLocation(
  instanceLocation: string
): string | undefined {
  const parts = instanceLocation.split("/");

  if (parts.length === 2) {
    return parts[1];
  }

  return undefined;
}

// error will be the string like: Instance does not have required property "issueAtField"
// We want to return issueAtField
function parseBlockIdFromRequiredError(error: string): string | undefined {
  const regex = /property "(.*)"/;

  const match = error.match(regex);

  if (match && match[1]) {
    return match[1];
  }
}

function safeJsonParse(json: string): unknown | undefined {
  try {
    return JSON.parse(json);
  } catch (error) {
    return undefined;
  }
}

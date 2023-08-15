import { OpenAIApi, Configuration } from "openai";
import { z } from "zod";

function createExampleResponse(args: {
  index: string;
  types: string;
  tasks: string;
  packageName: string;
  sdkPackage: string;
}) {
  const exampleFiles = {
    "index.ts": args.index,
    "types.ts": args.types,
    "tasks.ts": args.tasks,
  };

  return `
    Here is an example of what the files should look like for the package "${
      args.packageName
    }" using the SDK package "${args.sdkPackage}".

    (Note that these files are formatted as a pair of JSON key/values, where the key is the file name and the value is the file contents.)

    ${JSON.stringify(exampleFiles, null, 2)}
  `;
}

function createPrompt(packageName: string, sdkPackage: string, extraInfo?: string) {
  return `'I\'m wanting to know what the minimal starting point index.ts, types.ts, and tasks.ts files should look like for the package "${packageName}" using the SDK package "${sdkPackage}". ${
    extraInfo ?? ""
  }`;
}

function createExampleMessages() {
  return [
    {
      role: "user",
      content: createPrompt(
        "@trigger.dev.slack",
        "@slack/web-api",
        "Note that the only auth method support for slack is OAuth2 so shouldn't allow usesLocalAuth set to true"
      ),
    },
    {
      role: "assistant",
      content: createExampleResponse({
        packageName: "@trigger.dev/slack",
        sdkPackage: "@slack/web-api",
        index: `
import { WebClient } from "@slack/web-api";
import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import type { SlackSDK, SlackIntegrationOptions } from "./types";
import * as tasks from "./tasks";

export * from "./types";

type SlackIntegrationClient = IntegrationClient<SlackSDK, typeof tasks>;
type SlackIntegration = TriggerIntegration<SlackIntegrationClient>;

export class Slack
  implements SlackIntegration
{
  client: SlackIntegrationClient;

  constructor(private options: SlackIntegrationOptions) {
    this.client = {
      tasks,
      usesLocalAuth: false,
      clientFactory: (auth) => {
        return new WebClient(auth.accessToken);
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "slack", name: "Slack.com" };
  }
}
          `,
        tasks: `
import type {
  SlackSDK,
  ChatPostMessageParams,
  ChatPostMessageResponse,
} from "./types";

export const postMessage: AuthenticatedTask<
  SlackSDK,
  ChatPostMessageParams,
  ChatPostMessageResponse
> = {
  run: async (params, client, task, io, auth) => {
    const response = await client.chat.postMessage(params);

    return response;
  },
  init: (params) => {
    return {
      name: "Post Message",
      params,
      icon: "slack",
      properties: [
        {
          label: "Channel ID",
          text: params.channel,
        },
        ...(params.text ? [{ label: "Message", text: params.text }] : []),
      ],
    };
  },
};
          `,
        types: `
import { WebClient } from "@slack/web-api";
import { Prettify } from "@trigger.dev/integration-kit";

export type SlackSDK = WebClient;

export type SlackIntegrationOptions = {
  id: string;
};

export type ChatPostMessageParams = {
  channel: string;
  text?: string;
  as_user?: boolean;
  attachments?: MessageAttachment[];
  blocks?: (KnownBlock | Block)[];
  icon_emoji?: string;
  icon_url?: string;
  metadata?: MessageMetadata;
  link_names?: boolean;
  mrkdwn?: boolean;
  parse?: "full" | "none";
  reply_broadcast?: boolean;
  thread_ts?: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
  username?: string;
};

export type ChatPostMessageResponse = Prettify<Awaited<ReturnType<SlackSDK["chat"]["postMessage"]>>>;
          `,
      }),
    },
    {
      role: "user",
      content: createPrompt(
        "@trigger.dev/typeform",
        "@typeform/api-client",
        "Note that the only auth method support for typeform is API Key should only allow usesLocalAuth set to true"
      ),
    },
    {
      role: "assistant",
      content: createExampleResponse({
        packageName: "@trigger.dev/typeform",
        sdkPackage: "@typeform/api-client",
        index: `
import { createClient } from "@typeform/api-client";
import {
  TypeformIntegrationOptions,
  TypeformSDK,
} from "./types";
import {
  TriggerIntegration,
  IntegrationClient,
} from "@trigger.dev/sdk";

import * as tasks from "./tasks";


export * from "./types";

type TypeformIntegration = TriggerIntegration<TypeformIntegrationClient>;
type TypeformIntegrationClient = IntegrationClient<TypeformSDK, typeof tasks>;

type TypeformSource = ReturnType<typeof createWebhookEventSource>;
type TypeformTrigger = ReturnType<typeof createWebhookEventTrigger>;

export class Typeform implements TypeformIntegration {
  client: TypeformIntegrationClient;

  constructor(private options: TypeformIntegrationOptions) {
    this.client = {
      tasks,
      usesLocalAuth: true,
      client: createClient({ token: options.token }),
      auth: {
        token: options.token,
        apiBaseUrl: options.apiBaseUrl,
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "typeform", name: "Typeform" };
  }
}
          `,
        tasks: `
import type { AuthenticatedTask } from "@trigger.dev/sdk";
import type {
  GetFormParams,
  GetFormResponse,
  TypeformSDK,
} from "./types";

export const getForm: AuthenticatedTask<TypeformSDK, GetFormParams, GetFormResponse> =
  {
    run: async (params, client) => {
      return client.forms.get(params);
    },
    init: (params) => {
      return {
        name: "Get Form",
        params,
        icon: "typeform",
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
        ],
      };
    },
  };
          `,
        types: `
import { Prettify } from "@trigger.dev/integration-kit";
import { Typeform, createClient } from "@typeform/api-client";

export type TypeformIntegrationOptions = {
  id: string;
  token: string;
  apiBaseUrl?: string;
};

export type TypeformSDK = ReturnType<typeof createClient>;

export type GetFormParams = {
  uid: string;
};
export type GetFormResponse = Prettify<Typeform.Form>;
          `,
      }),
    },
  ] as const;
}

export async function generateIntegrationFiles(
  payload: {
    packageName: string;
    sdkPackage: string;
    extraInfo?: string;
  },
  apiKey: string
) {
  if (!apiKey) {
    return;
  }

  const openai = new OpenAIApi(
    new Configuration({
      apiKey,
      organization: process.env.OPENAI_ORGANIZATION,
    })
  );

  try {
    const response = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content:
            "You will be provided with the task of creating the typescript files necessary for a new Trigger.dev integration package. You will be provided the name of the integration package and the name of the SDK package.",
        },
        ...createExampleMessages(),
        {
          role: "user",
          content: createPrompt(payload.packageName, payload.sdkPackage, payload.extraInfo),
        },
      ],
      function_call: { name: "createTypescriptFiles" },
      functions: [
        {
          name: "createTypescriptFiles",
          description: "Creates the initial typescript files for a new Trigger.dev package",
          parameters: {
            type: "object",
            properties: {
              "index.ts": {
                type: "string",
                description: "The contents of the index.ts file",
              },
              "tasks.ts": {
                type: "string",
                description: "The contents of the tasks.ts file",
              },
              "types.ts": {
                type: "string",
                description: "The contents of the types.ts file",
              },
            },
          },
        },
      ],
    });

    const responseData = response.data;

    const firstChoice = responseData.choices[0];

    if (!firstChoice) {
      return;
    }

    const message = firstChoice.message;

    if (!message) {
      return;
    }

    if (!message.function_call || !message.function_call.arguments) {
      return;
    }

    const functionCallArgs = safeJsonParse(message.function_call.arguments);

    if (!functionCallArgs) {
      return;
    }

    const filesSchema = z.record(z.string());

    const files = filesSchema.safeParse(functionCallArgs);

    if (!files.success) {
      return;
    }

    return files.data;
  } catch (error) {
    console.error(error);
    return;
  }
}

function safeJsonParse(jsonString: string) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    return null;
  }
}

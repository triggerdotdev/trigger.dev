import { OpenAI } from "openai";
import { z } from "zod";

function createExampleResponse(args: {
  files: Record<string, string>;
  packageName: string;
  sdkPackage: string;
}) {
  return `
    Here is an example of what the files should look like for the package "${
      args.packageName
    }" using the SDK package "${args.sdkPackage}".

    (Note that these files are formatted as a pair of JSON key/values, where the key is the file name and the value is the file contents.)

    ${JSON.stringify(args.files, null, 2)}
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
        'Note that the only auth method support for slack is OAuth2 so so authSource() should be "HOSTED"'
      ),
    },
    {
      role: "assistant",
      content: createExampleResponse({
        packageName: "@trigger.dev/slack",
        sdkPackage: "@slack/web-api",
        files: {
          "index.ts": `
import type {
  Block,
  ChatPostMessageResponse,
  KnownBlock,
  MessageAttachment,
  MessageMetadata,
  WebAPIPlatformError,
} from "@slack/web-api";
import { WebClient } from "@slack/web-api";
import {
  retry,
  type ConnectionAuth,
  type IO,
  type IOTask,
  type IntegrationTaskKey,
  type Json,
  type RunTaskErrorCallback,
  type RunTaskOptions,
  type TriggerIntegration,
} from "@trigger.dev/sdk";

export type SlackIntegrationOptions = {
  id: string;
};

type ConversationsJoinResponse = Awaited<ReturnType<SlackClientType["conversations"]["join"]>>;

type SlackClientType = InstanceType<typeof WebClient>;

export type ChatPostMessageArguments = {
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

export class Slack implements TriggerIntegration {
  private _options: SlackIntegrationOptions;
  private _client?: WebClient;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: SlackIntegrationOptions) {
    this._options = options;
  }

  get authSource() {
    return "HOSTED" as const;
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "slack", name: "Slack.com" };
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const slack = new Slack(this._options);
    slack._io = io;
    slack._connectionKey = connectionKey;
    if (!auth) {
      throw new Error("No auth");
    }
    slack._client = new WebClient(auth.accessToken);
    return slack;
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: WebClient, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ): Promise<TResult> {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");

    return this._io.runTask<TResult>(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      {
        icon: "slack",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback
    );
  }

  postMessage(
    key: IntegrationTaskKey,
    params: ChatPostMessageArguments
  ): Promise<ChatPostMessageResponse> {
    return this.runTask(
      key,
      async (client) => {
        try {
          return client.chat.postMessage(params);
        } catch (error) {
          if (isPlatformError(error)) {
            if (error.data.error === "not_in_channel") {
              const joinResponse = await this.joinConversation(\`Join \${params.channel}\`, {
                channel: params.channel,
              });

              if (joinResponse.ok) {
                return client.chat.postMessage(params);
              }
            }
          }

          throw error;
        }
      },
      {
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
      }
    );
  }

  joinConversation(
    key: IntegrationTaskKey,
    params: { channel: string }
  ): Promise<ConversationsJoinResponse> {
    return this.runTask(
      key,
      async (client) => {
        return client.conversations.join(params);
      },
      {
        name: "Join Channel",
        params,
        icon: "slack",
        properties: [
          {
            label: "Channel ID",
            text: params.channel,
          },
        ],
      }
    );
  }
}

function isPlatformError(error: unknown): error is WebAPIPlatformError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "slack_webapi_platform_error"
  );
}        
          `,
        },
      }),
    },
    {
      role: "user",
      content: createPrompt(
        "@trigger.dev/typeform",
        "@typeform/api-client",
        'Note that the only auth method support for typeform is API Key so authSource() should be "LOCAL"'
      ),
    },
    {
      role: "assistant",
      content: createExampleResponse({
        packageName: "@trigger.dev/typeform",
        sdkPackage: "@typeform/api-client",
        files: {
          "index.ts": `
import { safeParseBody } from "@trigger.dev/integration-kit";
import {
  ConnectionAuth,
  EventSpecification,
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  IO,
  IOTask,
  IntegrationTaskKey,
  Json,
  Logger,
  RunTaskErrorCallback,
  RunTaskOptions,
  TriggerIntegration,
  retry,
} from "@trigger.dev/sdk";
import { createClient } from "@typeform/api-client";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { Forms } from "./forms";
import { Responses } from "./responses";
import {
  FormResponseEvent,
  GetWebhookResponse,
  TypeformIntegrationOptions,
  TypeformSDK,
} from "./types";

export * from "./types";

type TypeformSource = ReturnType<typeof createWebhookEventSource>;
type TypeformTrigger = ReturnType<typeof createWebhookEventTrigger>;
export type TypeformRunTask = InstanceType<typeof Typeform>["runTask"];

export class Typeform implements TriggerIntegration {
  private _options: TypeformIntegrationOptions;
  private _client?: TypeformSDK;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(private options: TypeformIntegrationOptions) {
    if (Object.keys(options).includes("token") && !options.token) {
      throw \`Can't create Typeform integration (\${options.id}) as token was undefined\`;
    }

    this._options = options;
  }

  get authSource() {
    return "LOCAL" as const;
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "typeform", name: "Typeform" };
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const typeform = new Typeform(this._options);
    typeform._io = io;
    typeform._connectionKey = connectionKey;
    typeform._client = createClient({ token: this._options.token });
    return typeform;
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: TypeformSDK, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ): Promise<TResult> {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");
    return this._io.runTask(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      {
        icon: "typeform",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback
    );
  }

  get forms() {
    return new Forms(this.runTask.bind(this));
  }

  get responses() {
    return new Responses(this.runTask.bind(this));
  }
}       
          `,
          "forms.ts": `
import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { GetFormParams, GetFormResponse, ListFormsParams, TypeformRunTask } from ".";
import { Typeform } from "@typeform/api-client";

export class Forms {
  runTask: TypeformRunTask;

  constructor(runTask: TypeformRunTask) {
    this.runTask = runTask;
  }

  list(key: IntegrationTaskKey, params: ListFormsParams): Promise<Typeform.API.Forms.List> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.forms.list(params ?? {});
      },
      {
        name: "List Forms",
        params,
        properties: [
          ...(params?.workspaceId ? [{ label: "Workspace ID", text: params.workspaceId }] : []),
          ...(params?.search ? [{ label: "Search", text: params.search }] : []),
          ...(params?.page ? [{ label: "Page", text: String(params.page) }] : []),
          ...(params?.pageSize ? [{ label: "Page Size", text: String(params.pageSize) }] : []),
        ],
      }
    );
  }

  get(key: IntegrationTaskKey, params: GetFormParams): Promise<GetFormResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.forms.get(params);
      },
      {
        name: "Get Form",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
        ],
      }
    );
  }
}
          `,
          "responses.ts": `
import { IntegrationTaskKey } from "@trigger.dev/sdk";
import {
  GetAllResponsesParams,
  GetAllResponsesResponse,
  ListResponsesParams,
  ListResponsesResponse,
  TypeformRunTask,
} from ".";

export class Responses {
  runTask: TypeformRunTask;

  constructor(runTask: TypeformRunTask) {
    this.runTask = runTask;
  }

  list(key: IntegrationTaskKey, params: ListResponsesParams): Promise<ListResponsesResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.responses.list(params);
      },
      {
        name: "List Responses",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
        ],
      }
    );
  }

  all(key: IntegrationTaskKey, params: GetAllResponsesParams): Promise<GetAllResponsesResponse> {
    const pageSize = 50;

    const listResponsesForPage = (before?: string) => {
      const pageParams = {
        ...params,
        submitted_at: "desc",
        before,
        pageSize: pageSize,
      };

      return this.list(\`page\${before ? \`-before-\${before}\` : ""}\`, pageParams);
    };

    return this.runTask(
      key,
      async (client, task) => {
        // We're going to create a subtask for each page of responses
        const firstPage = await listResponsesForPage();
        let token = firstPage.items[firstPage.items.length - 1].token;

        const totalPages = Math.ceil(firstPage.total_items / pageSize);
        const allResponses = firstPage.items;

        for (let i = 1; i < totalPages; i++) {
          const page = await listResponsesForPage(token);
          token = page.items[page.items.length - 1].token;
          allResponses.push(...page.items);
        }

        return allResponses;
      },
      {
        name: "Get All Responses",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
        ],
      }
    );
  }
}
          
          `,
          "types.ts": `
          import { Prettify } from "@trigger.dev/integration-kit";
import { Typeform, createClient } from "@typeform/api-client";

export type TypeformIntegrationOptions = {
  id: string;
  token: string;
  apiBaseUrl?: string;
};

export type TypeformSDK = ReturnType<typeof createClient>;

export type ListFormsParams = {
  page?: number;
  pageSize?: number;
  search?: string;
  workspaceId?: string;
} | void;

export type ListFormsResponse = Prettify<Typeform.API.Forms.List>;

export type ListResponsesParams = {
  uid: string;
  pageSize?: number;
  since?: string;
  until?: string;
  after?: string;
  before?: string;
  ids?: string | string[];
  completed?: boolean;
  sort?: string;
  query?: string;
  fields?: string | string[];
};

//fix because the Typeform SDK doesn't have the \`token\` property on an item…
type ResponseListItem = Prettify<Typeform.API.Responses.List["items"][number]> & {
  token?: string;
};

export type ListResponsesResponse = Prettify<
  Omit<Typeform.API.Responses.List, "items"> & { items: ResponseListItem[] }
>;

export type GetFormParams = {
  uid: string;
};

export type GetFormResponse = Prettify<Typeform.Form>;

export type GetAllResponsesParams = Prettify<Omit<ListResponsesParams, "pageSize">>;

export type GetAllResponsesResponse = Prettify<Typeform.API.Responses.List["items"]>;

export type GetWebhookResponse = Prettify<Typeform.Webhook>;

export type ListWebhooksParams = {
  uid: string;
};

export type ListWebhooksResponse = Prettify<Typeform.API.Webhooks.List>;

export type CreateWebhookParams = {
  uid: string;
  tag: string;
  url: string;
  enabled?: boolean;
  secret?: string;
  verifySSL?: boolean;
};

export type UpdateWebhookParams = {
  uid: string;
  tag: string;
  url: string;
  enabled?: boolean;
  secret?: string;
  verifySSL?: boolean;
};

export type GetWebhookParams = {
  uid: string;
  tag: string;
};

export type DeleteWebhookParams = {
  uid: string;
  tag: string;
};

export type DeleteWebhookResponse = null;

export type FormResponseEvent = {
  event_id: string;
  event_type: "form_response";
  form_response: {
    form_id: string;
    token: string;
    landed_at: string;
    submitted_at: string;
    calculated: {
      score: number;
    };
    variables: Array<
      | {
          key: string;
          type: "number";
          number: number;
        }
      | {
          key: string;
          type: "text";
          text: string;
        }
    >;
    hidden: Record<string, string>;
    definition: {
      id: string;
      title: string;
      fields: Array<{
        id: string;
        ref: string;
        type: string;
        title: string;
        allow_multiple_selections?: boolean;
        allow_other_choice?: boolean;
        properties?: Record<string, string | boolean | number>;
        choices?: Array<{
          id: string;
          label: string;
        }>;
      }>;
      ending: {
        id: string;
        title: string;
        ref: string;
        type: string;
        properties?: Record<string, string | boolean | number>;
      };
    };
    answers: Array<FormResponseAnswer>;
    ending: {
      id: string;
      ref: string;
    };
  };
};

type FormResponseAnswerBase = {
  field: {
    id: string;
    type: string;
    ref: string;
  };
};
type FormResponseAnswerEmail = Prettify<
  FormResponseAnswerBase & {
    type: "email";
    email: string;
  }
>;

type FormResponseAnswerText = Prettify<
  FormResponseAnswerBase & {
    type: "text";
    text: string;
  }
>;

type FormResponseAnswerNumber = Prettify<
  FormResponseAnswerBase & {
    type: "number";
    number: number;
  }
>;

type FormResponseAnswerBoolean = Prettify<
  FormResponseAnswerBase & {
    type: "boolean";
    boolean: boolean;
  }
>;

type FormResponseAnswerDate = Prettify<
  FormResponseAnswerBase & {
    type: "date";
    date: string;
  }
>;

type FormResponseAnswerChoice = Prettify<
  FormResponseAnswerBase & {
    type: "choice";
    choice: {
      label: string;
    };
  }
>;

type FormResponseAnswer = Prettify<
  | FormResponseAnswerEmail
  | FormResponseAnswerText
  | FormResponseAnswerNumber
  | FormResponseAnswerBoolean
  | FormResponseAnswerDate
  | FormResponseAnswerChoice
>;

          `,
        },
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
  apiKey: string,
  openAiOrg: string | undefined
) {
  if (!apiKey) {
    return;
  }

  const openai = new OpenAI({ apiKey, organization: openAiOrg });

  try {
    const result = await openai.chat.completions.create({
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
            },
          },
        },
      ],
    });

    const firstChoice = result.choices[0];

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

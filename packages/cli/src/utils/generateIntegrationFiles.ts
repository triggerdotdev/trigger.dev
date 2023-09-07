import { OpenAIApi, Configuration } from "openai";
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
import { SOURCE } from "./consts";
import { Forms } from "./forms";
import { formResponseExample } from "./payload-examples";
import { Responses } from "./responses";
import {
  FormResponseEvent,
  GetWebhookResponse,
  TypeformIntegrationOptions,
  TypeformSDK,
} from "./types";
import { Webhooks } from "./webhooks";

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

  listForms = this.forms.list;
  getForm = this.forms.get;

  get responses() {
    return new Responses(this.runTask.bind(this));
  }

  listResponses = this.responses.list;

  /** @deprecated this is being replaced by responses.all */
  getAllResponses = this.responses.all.bind(this.responses);

  get webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }

  createWebhook = this.webhooks.create;
  listWebhooks = this.webhooks.list;
  updateWebhook = this.webhooks.update;
  getWebhook = this.webhooks.get;
  deleteWebhook = this.webhooks.delete;

  get source(): TypeformSource {
    return createWebhookEventSource(this);
  }

  get trigger(): TypeformTrigger {
    return createWebhookEventTrigger(this.source);
  }

  onFormResponse(params: { uid: string; tag: string }) {
    return this.trigger({
      event: events.onFormResponse,
      uid: params.uid,
      tag: params.tag,
    });
  }
}

const onFormResponse: EventSpecification<FormResponseEvent> = {
  name: "form_response",
  title: "On issue",
  source: SOURCE,
  icon: "typeform",
  examples: [formResponseExample],
  parsePayload: (payload) => payload as FormResponseEvent,
  runProperties: (payload) => [{ label: "Form ID", text: payload.form_response.form_id }],
};

export const events = {
  onFormResponse,
};

type TypeformEvents = (typeof events)[keyof typeof events];

type CreateTypeformTriggerReturnType = <TEventSpecification extends TypeformEvents>(args: {
  event: TEventSpecification;
  uid: string;
  tag: string;
}) => ExternalSourceTrigger<TEventSpecification, ReturnType<typeof createWebhookEventSource>>;

function createWebhookEventTrigger(
  source: ReturnType<typeof createWebhookEventSource>
): CreateTypeformTriggerReturnType {
  return <TEventSpecification extends TypeformEvents>({
    event,
    uid,
    tag,
  }: {
    event: TEventSpecification;
    uid: string;
    tag: string;
  }) => {
    return new ExternalSourceTrigger({
      event,
      params: { uid, tag },
      source,
      options: {},
    });
  };
}

const WebhookSchema = z.object({
  uid: z.string(),
  tag: z.string(),
});

export function createWebhookEventSource(
  integration: Typeform
): ExternalSource<Typeform, { uid: string; tag: string }, "HTTP", {}> {
  return new ExternalSource("HTTP", {
    id: "typeform.forms",
    schema: WebhookSchema,
    version: "0.1.1",
    integration,
    filter: (params) => {
      return {
        event_type: ["form_response"],
      };
    },
    key: (params) => \`\${params.uid}/\${params.tag}\`,
    properties: (params) => [
      {
        label: "Form ID",
        text: params.uid,
      },
      {
        label: "Tag",
        text: params.tag,
      },
    ],
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource } = event;

      const registeredOptions = {
        event: ["form_response"],
      };

      if (httpSource.active && isWebhookData(httpSource.data) && !httpSource.data.enabled) {
        // Update the webhook to re-enable it
        const newWebhookData = await io.integration.updateWebhook("update-webhook", {
          uid: params.uid,
          tag: params.tag,
          url: httpSource.url,
          enabled: true,
          secret: httpSource.secret,
          verifySSL: true,
        });

        return {
          data: newWebhookData,
          options: registeredOptions,
        };
      }

      const createWebhook = async () => {
        const newWebhookData = await io.integration.createWebhook("create-webhook", {
          uid: params.uid,
          tag: params.tag,
          url: httpSource.url,
          enabled: true,
          secret: httpSource.secret,
          verifySSL: true,
        });

        return {
          data: newWebhookData,
          options: registeredOptions,
        };
      };

      try {
        const existingWebhook = await io.integration.getWebhook("get-webhook", params);

        if (existingWebhook.url !== httpSource.url) {
          return createWebhook();
        }

        if (existingWebhook.enabled) {
          return {
            data: existingWebhook,
            options: registeredOptions,
          };
        }

        const newWebhookData = await io.integration.updateWebhook("update-webhook", {
          uid: params.uid,
          tag: params.tag,
          url: httpSource.url,
          enabled: true,
          secret: httpSource.secret,
          verifySSL: true,
        });

        return {
          data: newWebhookData,
          options: registeredOptions,
        };
      } catch (error) {
        return createWebhook();
      }
    },
  });
}

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger) {
  logger.debug("[inside typeform integration] Handling typeform webhook handler");

  const { rawEvent: request, source } = event;

  if (!request.body) {
    logger.debug("[inside typeform integration] No body found");

    return;
  }

  const rawBody = await request.text();

  const signature = request.headers.get("typeform-signature");

  if (!signature) {
    logger.debug("[inside typeform integration] No signature found");

    return { events: [] };
  }

  const hash = createHmac("sha256", source.secret).update(rawBody).digest("base64");

  const actualSig = \`sha256=\${hash}\`;

  if (signature !== actualSig) {
    logger.debug("[inside typeform integration] Signature does not match, ignoring");

    return { events: [] };
  }

  const payload = safeParseBody(rawBody);

  return {
    events: [
      {
        id: payload.event_id,
        name: payload.event_type,
        source: SOURCE,
        payload,
        context: {},
      },
    ],
  };
}

function isWebhookData(data: any): data is GetWebhookResponse {
  return typeof data === "object" && data !== null && typeof data.id === "string";
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
          "consts.ts": `
export const SOURCE = "typeform.com";
          `,
          "payload-examples.ts": `
import { EventSpecificationExample } from "@trigger.dev/sdk";

export const formResponseExample: EventSpecificationExample = {
  id: "form_response",
  name: "Form response",
  payload: {
    event_id: "LtWXD3crgy",
    event_type: "form_response",
    form_response: {
      form_id: "lT4Z3j",
      token: "a3a12ec67a1365927098a606107fac15",
      submitted_at: "2018-01-18T18:17:02Z",
      landed_at: "2018-01-18T18:07:02Z",
      calculated: {
        score: 9,
      },
      variables: [
        {
          key: "score",
          type: "number",
          number: 4,
        },
        {
          key: "name",
          type: "text",
          text: "typeform",
        },
      ],
      hidden: {
        user_id: "abc123456",
      },
      definition: {
        id: "lT4Z3j",
        title: "Webhooks example",
        fields: [
          {
            id: "DlXFaesGBpoF",
            title:
              "Thanks, {{answer_60906475}}! What's it like where you live? Tell us in a few sentences.",
            type: "long_text",
            ref: "readable_ref_long_text",
            allow_multiple_selections: false,
            allow_other_choice: false,
          },
          {
            id: "SMEUb7VJz92Q",
            title:
              "If you're OK with our city management following up if they have further questions, please give us your email address.",
            type: "email",
            ref: "readable_ref_email",
            allow_multiple_selections: false,
            allow_other_choice: false,
          },
          {
            id: "JwWggjAKtOkA",
            title: "What is your first name?",
            type: "short_text",
            ref: "readable_ref_short_text",
            allow_multiple_selections: false,
            allow_other_choice: false,
          },
          {
            id: "KoJxDM3c6x8h",
            title: "When did you move to the place where you live?",
            type: "date",
            ref: "readable_ref_date",
            allow_multiple_selections: false,
            allow_other_choice: false,
          },
          {
            id: "PNe8ZKBK8C2Q",
            title: "Which pictures do you like? You can choose as many as you like.",
            type: "picture_choice",
            ref: "readable_ref_picture_choice",
            allow_multiple_selections: true,
            allow_other_choice: false,
          },
          {
            id: "Q7M2XAwY04dW",
            title:
              "On a scale of 1 to 5, what rating would you give the weather in Sydney? 1 is poor weather, 5 is excellent weather",
            type: "number",
            ref: "readable_ref_number1",
            allow_multiple_selections: false,
            allow_other_choice: false,
          },
          {
            id: "gFFf3xAkJKsr",
            title:
              "By submitting this form, you understand and accept that we will share your answers with city management. Your answers will be anonymous will not be shared.",
            type: "legal",
            ref: "readable_ref_legal",
            allow_multiple_selections: false,
            allow_other_choice: false,
          },
          {
            id: "k6TP9oLGgHjl",
            title: "Which of these cities is your favorite?",
            type: "multiple_choice",
            ref: "readable_ref_multiple_choice",
            allow_multiple_selections: false,
            allow_other_choice: false,
          },
          {
            id: "RUqkXSeXBXSd",
            title: "Do you have a favorite city we haven't listed?",
            type: "yes_no",
            ref: "readable_ref_yes_no",
            allow_multiple_selections: false,
            allow_other_choice: false,
          },
          {
            id: "NRsxU591jIW9",
            title:
              "How important is the weather to your opinion about a city? 1 is not important, 5 is very important.",
            type: "opinion_scale",
            ref: "readable_ref_opinion_scale",
            allow_multiple_selections: false,
            allow_other_choice: false,
          },
          {
            id: "WOTdC00F8A3h",
            title:
              "How would you rate the weather where you currently live? 1 is poor weather, 5 is excellent weather.",
            type: "rating",
            ref: "readable_ref_rating",
            allow_multiple_selections: false,
            allow_other_choice: false,
          },
          {
            id: "pn48RmPazVdM",
            title:
              "On a scale of 1 to 5, what rating would you give the general quality of life in Sydney? 1 is poor, 5 is excellent",
            type: "number",
            ref: "readable_ref_number2",
            allow_multiple_selections: false,
            allow_other_choice: false,
          },
          {
            id: "M5tXK5kG7IeA",
            title: "Book a time with me",
            type: "calendly",
            ref: "readable_ref_calendly",
            properties: {},
          },
        ],
        endings: [
          {
            id: "dN5FLyFpCMFo",
            ref: "01GRC8GR2017M6WW347T86VV39",
            title: "Bye!",
            type: "thankyou_screen",
            properties: {
              button_text: "Create a typeform",
              show_button: true,
              share_icons: true,
              button_mode: "default_redirect",
            },
          },
        ],
      },
      answers: [
        {
          type: "text",
          text: "It's cold right now! I live in an older medium-sized city with a university. Geographically, the area is hilly.",
          field: {
            id: "DlXFaesGBpoF",
            type: "long_text",
          },
        },
        {
          type: "email",
          email: "laura@example.com",
          field: {
            id: "SMEUb7VJz92Q",
            type: "email",
          },
        },
        {
          type: "text",
          text: "Laura",
          field: {
            id: "JwWggjAKtOkA",
            type: "short_text",
          },
        },
        {
          type: "date",
          date: "2005-10-15",
          field: {
            id: "KoJxDM3c6x8h",
            type: "date",
          },
        },
        {
          type: "choices",
          choices: {
            labels: ["London", "Sydney"],
          },
          field: {
            id: "PNe8ZKBK8C2Q",
            type: "picture_choice",
          },
        },
        {
          type: "number",
          number: 5,
          field: {
            id: "Q7M2XAwY04dW",
            type: "number",
          },
        },
        {
          type: "boolean",
          boolean: true,
          field: {
            id: "gFFf3xAkJKsr",
            type: "legal",
          },
        },
        {
          type: "choice",
          choice: {
            label: "London",
          },
          field: {
            id: "k6TP9oLGgHjl",
            type: "multiple_choice",
          },
        },
        {
          type: "boolean",
          boolean: false,
          field: {
            id: "RUqkXSeXBXSd",
            type: "yes_no",
          },
        },
        {
          type: "number",
          number: 2,
          field: {
            id: "NRsxU591jIW9",
            type: "opinion_scale",
          },
        },
        {
          type: "number",
          number: 3,
          field: {
            id: "WOTdC00F8A3h",
            type: "rating",
          },
        },
        {
          type: "number",
          number: 4,
          field: {
            id: "pn48RmPazVdM",
            type: "number",
          },
        },
        {
          type: "url",
          url: "https://calendly.com/scheduled_events/EVENT_TYPE/invitees/INVITEE",
          field: {
            id: "M5tXK5kG7IeA",
            type: "calendly",
            ref: "readable_ref_calendly",
          },
        },
      ],
      ending: {
        id: "dN5FLyFpCMFo",
        ref: "01GRC8GR2017M6WW347T86VV39",
      },
    },
  },
};
          
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
          "webhooks.ts": `
import { IntegrationTaskKey } from "@trigger.dev/sdk";
import {
  CreateWebhookParams,
  DeleteWebhookParams,
  DeleteWebhookResponse,
  GetWebhookParams,
  GetWebhookResponse,
  ListWebhooksParams,
  ListWebhooksResponse,
  TypeformRunTask,
  UpdateWebhookParams,
} from ".";

export class Webhooks {
  runTask: TypeformRunTask;

  constructor(runTask: TypeformRunTask) {
    this.runTask = runTask;
  }

  create(key: IntegrationTaskKey, params: CreateWebhookParams): Promise<GetWebhookResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.webhooks.create(params);
      },
      {
        name: "Create Webhook",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
          {
            label: "Tag",
            text: params.tag,
          },
        ],
      }
    );
  }

  list(key: IntegrationTaskKey, params: ListWebhooksParams): Promise<ListWebhooksResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.webhooks.list(params);
      },
      {
        name: "List Webhooks",
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

  update(key: IntegrationTaskKey, params: UpdateWebhookParams): Promise<GetWebhookResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.webhooks.update(params);
      },
      {
        name: "Update Webhook",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
          {
            label: "Tag",
            text: params.tag,
          },
        ],
      }
    );
  }

  get(key: IntegrationTaskKey, params: GetWebhookParams): Promise<GetWebhookResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.webhooks.get(params);
      },
      {
        name: "Get Webhook",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
          {
            label: "Tag",
            text: params.tag,
          },
        ],
      }
    );
  }

  delete(key: IntegrationTaskKey, params: DeleteWebhookParams): Promise<DeleteWebhookResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.webhooks.delete(params);
      },
      {
        name: "Delete Webhook",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
          {
            label: "Tag",
            text: params.tag,
          },
        ],
      }
    );
  }
}

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

import {
  TriggerIntegration,
  RunTaskOptions,
  IO,
  IOTask,
  IntegrationTaskKey,
  RunTaskErrorCallback,
  Json,
  retry,
  ConnectionAuth,
} from "@trigger.dev/sdk";

import {
  ApiVersion,
  LATEST_API_VERSION,
  LogSeverity,
  Session,
  shopifyApi,
} from "@shopify/shopify-api";
// this has to be updated manually with each LATEST_API_VERSION bump
import { restResources, type RestResources } from "@shopify/shopify-api/rest/admin/2023-10";
import "@shopify/shopify-api/adapters/node";

import { ApiScope, WebhookTopic } from "./schemas";
import { triggerCatalog } from "./triggers";
import {
  ShopifyApiError,
  TriggerParams,
  Webhooks,
  createTrigger,
  createWebhookEventSource,
} from "./webhooks";

export { RestResources as ShopifyRestResources };

export type ShopifyIntegrationOptions = {
  id: string;
  apiKey?: string;
  apiSecretKey: string;
  apiVersion?: ApiVersion;
  adminAccessToken: string;
  hostName: string;
  scopes: ApiScope[];
  session?: Session;
};

export type ShopifyRunTask = InstanceType<typeof Shopify>["runTask"];

export class Shopify implements TriggerIntegration {
  private _options: ShopifyIntegrationOptions;

  private _client?: ReturnType<(typeof this)["createClient"]>;
  private _io?: IO;
  private _connectionKey?: string;
  private _session?: Session;
  private _shopDomain: string;

  constructor(private options: ShopifyIntegrationOptions) {
    if (Object.keys(options).includes("apiKey") && !options.apiKey) {
      throw `Can't create Shopify integration (${options.id}) as apiKey was undefined`;
    }

    this._options = options;
    this._shopDomain = this._options.hostName.replace("http://", "").replace("https://", "")
  }

  get authSource() {
    return this._options.apiKey ? "LOCAL" : "HOSTED";
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "shopify", name: "Shopify" };
  }

  get clientSecret() {
    return this._options.apiSecretKey;
  }

  get source() {
    return createWebhookEventSource(this);
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const shopify = new Shopify(this._options);

    const client = this.createClient(auth);

    const session = client.session.customAppSession(client.config.hostName);
    session.accessToken = client.config.adminApiAccessToken;

    shopify._io = io;
    shopify._connectionKey = connectionKey;
    shopify._client = client;
    shopify._session = this._options.session ?? session;

    return shopify;
  }

  createClient(auth?: ConnectionAuth) {
    // oauth
    if (auth) {
      return shopifyApi({
        apiKey: this._options.apiKey,
        apiSecretKey: auth.accessToken,
        adminApiAccessToken: this._options.adminAccessToken,
        apiVersion: this._options.apiVersion ?? LATEST_API_VERSION,
        hostName: this._shopDomain,
        scopes: auth.scopes,
        restResources,
        // TODO: double check this
        isEmbeddedApp: true,
        logger: {
          level: LogSeverity.Warning,
        },
      });
    }

    // apiKey auth
    if (this._options.apiKey) {
      return shopifyApi({
        apiKey: this._options.apiKey,
        apiSecretKey: this._options.apiKey,
        adminApiAccessToken: this._options.adminAccessToken,
        apiVersion: this._options.apiVersion ?? LATEST_API_VERSION,
        hostName: this._shopDomain,
        // TODO: check if this is safe to remove
        scopes: this._options.scopes,
        restResources,
        // TODO: double check this
        isCustomStoreApp: true,
        isEmbeddedApp: false,
        logger: {
          level: LogSeverity.Warning,
        },
      });
    }

    throw new Error("No auth");
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (
      client: ReturnType<Shopify["createClient"]>,
      task: IOTask,
      io: IO,
      session: Session
    ) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ): Promise<TResult> {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");

    return this._io.runTask<TResult>(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        if (!this._session) throw new Error("No session");
        return callback(this._client, task, io, this._session);
      },
      {
        icon: "shopify",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback ?? onError
    );
  }

  on<TTopic extends WebhookTopic>(topic: TTopic, params?: Omit<TriggerParams, "topic">) {
    const { eventSpec, params: catalogParams } = triggerCatalog[topic];

    return createTrigger(this.source, eventSpec, {
      ...params,
      ...catalogParams,
    });
  }

  get webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }
}

function isShopifyApiError(error: unknown): error is ShopifyApiError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const apiError = error as ShopifyApiError;

  return apiError.name === "ShopifyApiError" && apiError.response instanceof Response;
}

function shouldRetry(method: string, status: number) {
  return status === 429 || (method === "GET" && status >= 500);
}

export function onError(error: unknown): ReturnType<RunTaskErrorCallback> {
  // TODO: handle InvalidShopError etc

  if (!isShopifyApiError(error)) {
    return {
      skipRetrying: true,
    };
  }

  if (!shouldRetry(error.request.method, error.response.status)) {
    return {
      skipRetrying: true,
    };
  }

  const rateLimitRemaining = error.response.headers.get("ratelimit-remaining");
  const rateLimitReset = error.response.headers.get("ratelimit-reset");

  if (rateLimitRemaining === "0" && rateLimitReset) {
    const resetDate = new Date(Number(rateLimitReset) * 1000);

    if (!Number.isNaN(resetDate.getTime())) {
      return {
        retryAt: resetDate,
        error,
      };
    }
  }
}

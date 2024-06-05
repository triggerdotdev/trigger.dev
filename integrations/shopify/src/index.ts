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
import { OmitIndexSignature } from "@trigger.dev/integration-kit";

import {
  ApiVersion,
  HttpRetriableError,
  HttpThrottlingError,
  LATEST_API_VERSION,
  LogSeverity,
  Session,
  shopifyApi,
  ShopifyError,
} from "@shopify/shopify-api";

// this has to be updated manually with each LATEST_API_VERSION bump
import { restResources, type RestResources } from "@shopify/shopify-api/rest/admin/2023-10";

import { ApiScope } from "./schemas";
import { createWebhookEventCatalog, WebhookEventCatalog } from "./triggers";
import { Webhooks, createWebhookEventSource } from "./webhooks";
import { Rest, restProxy } from "./rest";

export type ShopifyRestResources = OmitIndexSignature<RestResources>;

export type ShopifyIntegrationOptions = {
  id: string;
  apiKey: string;
  apiSecretKey: string;
  apiVersion?: ApiVersion;
  adminAccessToken: string;
  hostName: string;
  restResources?: RestResources;
  scopes?: ApiScope[];
  session?: Session;
};

export type ShopifyRunTask = InstanceType<typeof Shopify>["runTask"];

type EventNamesFromCatalog<TEventCatalog extends WebhookEventCatalog<any, any>> =
  TEventCatalog extends WebhookEventCatalog<infer U, any> ? keyof U : never;

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

    if (Object.keys(options).includes("apiSecretKey") && !options.apiSecretKey) {
      throw `Can't create Shopify integration (${options.id}) as apiSecretKey was undefined`;
    }

    if (Object.keys(options).includes("adminAccessToken") && !options.adminAccessToken) {
      throw `Can't create Shopify integration (${options.id}) as adminAccessToken was undefined`;
    }

    if (Object.keys(options).includes("hostName") && !options.hostName) {
      throw `Can't create Shopify integration (${options.id}) as hostName was undefined`;
    }

    this._options = options;
    // Extract the shop domain if user has entered the full URL
    this._shopDomain = this._options.hostName
      .replace(/^https?:\/\//, "") // Remove http:// or https://
      .replace(/\/$/, ""); // Remove trailing slash if it exists (e.g. `example.myshopify.com/`)

    // Regular expression to ensure the shopDomain is a valid `.myshopify.com` domain
    const shopifyDomainPattern = /^[a-zA-Z0-9-]+\.myshopify\.com$/;

    if (!shopifyDomainPattern.test(this._shopDomain)) {
      throw `Can't create Shopify integration (${options.id}) because hostName should be a valid ".myshopify.com" domain, not a custom primary domain. For example: my-domain.myshopify.com`;
    }
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

  get #source() {
    return createWebhookEventSource(this);
  }

  get #eventCatalog() {
    return createWebhookEventCatalog(this.#source);
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
    // if (auth) {
    //   return shopifyApi({
    //     apiKey: this._options.apiKey,
    //     apiSecretKey: auth.accessToken,
    //     adminApiAccessToken: this._options.adminAccessToken,
    //     apiVersion: this._options.apiVersion ?? LATEST_API_VERSION,
    //     hostName: this._shopDomain,
    //     scopes: auth.scopes,
    //     restResources: this._options.restResources ?? restResources,
    //     isCustomStoreApp: false,
    //     isEmbeddedApp: true,
    //     logger: {
    //       level: LogSeverity.Warning,
    //     },
    //   });
    // }

    // apiKey auth
    if (this._options.apiKey) {
      return shopifyApi({
        apiKey: this._options.apiKey,
        apiSecretKey: this._options.apiSecretKey,
        adminApiAccessToken: this._options.adminAccessToken,
        apiVersion: this._options.apiVersion ?? LATEST_API_VERSION,
        hostName: this._shopDomain,
        scopes: this._options.scopes,
        restResources: this._options.restResources ?? restResources,
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

  /**
   * Creates a webhook trigger.
   */
  on<TName extends EventNamesFromCatalog<ReturnType<typeof createWebhookEventCatalog>>>(
    name: TName
    // additional params have been disabled, see WebhookSource schema
    // params?: Omit<GetWebhookParams<ReturnType<typeof createWebhookEventSource>>, "topic">
  ) {
    return this.#eventCatalog.on(name, { topic: name });
  }

  get #webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }

  get rest() {
    if (!this._session) {
      throw new Error("No session");
    }

    return restProxy(
      new Rest(this.runTask.bind(this), this._session),
      this._session,
      this.runTask.bind(this)
    );
  }
}

export function onError(error: unknown): ReturnType<RunTaskErrorCallback> {
  if (!(error instanceof ShopifyError)) {
    return;
  }

  if (!(error instanceof HttpRetriableError)) {
    return {
      skipRetrying: true,
    };
  }

  if (!(error instanceof HttpThrottlingError)) {
    return;
  }

  const retryAfter = error.response.retryAfter;

  if (retryAfter) {
    const retryAfterMs = Number(retryAfter) * 1000;

    if (Number.isNaN(retryAfterMs)) {
      return;
    }

    const resetDate = new Date(Date.now() + retryAfterMs);

    return {
      retryAt: resetDate,
      error,
    };
  }
}

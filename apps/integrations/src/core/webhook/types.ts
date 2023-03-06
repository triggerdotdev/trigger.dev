import { DisplayProperties } from "core/action/types";
import {
  AuthCredentials,
  IntegrationAuthentication,
} from "core/authentication/types";
import { EndpointSpec } from "core/endpoint/types";
import { HTTPMethod, HTTPResponse } from "core/request/types";
import { JSONSchema } from "core/schemas/types";

export type WebhookResultSuccess = {
  success: true;
  eventResults: WebhookEventResult[];
  response: HTTPResponse;
};

export type WebhookResultError = {
  success: false;
  error: string;
  response: HTTPResponse;
};

export type WebhookResult = WebhookResultSuccess | WebhookResultError;

export type Webhook = {
  baseUrl: string;
  spec: WebhookSpec;
  authentication: IntegrationAuthentication;
  events: WebhookEvent[];
  subscription: WebhookSubscription;
  receive: (data: WebhookReceiveRequest) => Promise<WebhookResult>;
};

export type WebhookSubscription =
  | WebhookSubscriptionAutomatic
  | WebhookSubscriptionManual;

export type WebhookSubscriptionAutomatic = {
  type: "automatic";
  requiresSecret: boolean;
  inputSpec: JSONSchema;
  subscribe: (
    data: WebhookSubscriptionRequest
  ) => Promise<WebhookSubscriptionResult>;
};

export type WebhookSubscriptionManual = {
  type: "manual";
  requiresSecret: boolean;
};

export type WebhookSpec = {
  id: string;
  metadata: WebhookMetadata;
  subscribe: WebhookSpecSubscribe;
};

export type WebhookMetadata = {
  name: string;
  description: string;
  externalDocs?: ExternalDocs;
  tags: string[];
};

type ExternalDocs = {
  description: string;
  url: string;
};

export type WebhookSpecSubscribe =
  | WebhookSpecSubscribeManual
  | WebhookSpecSubscribeAutomatic;

type WebhookSpecSubscribeManual = {
  type: "manual";
};

export interface WebhookSpecSubscribeAutomatic {
  type: "automatic";
  requiresSecret: boolean;
  create: EndpointSpec;
  //todo unregistering a webhook
  //todo updating a webhook to add more events
}

export type WebhookSubscriptionRequest = {
  webhookId: string;
  credentials?: AuthCredentials;
  callbackUrl: string;
  events: string[];
  secret?: string;
  inputData: Record<string, any>;
};

export type WebhookSubscriptionResult =
  | {
      success: true;
      callbackUrl: string;
      events: string[];
      secret?: string;
      status: number;
      headers?: Record<string, string>;
      data: any;
    }
  | {
      success: false;
      error: string;
    };

export type WebhookReceiveRequest = {
  credentials?: AuthCredentials;
  secret?: string;
  subscriptionData: Record<string, any>;
  request: WebhookIncomingRequest;
};

export type WebhookIncomingRequest = {
  method: HTTPMethod;
  searchParams: URLSearchParams;
  headers: Record<string, string>;
  body: any;
  rawBody: Buffer;
};

export type WebhookEvent = {
  name: string;
  metadata: WebhookEventMetadata;
  schema: JSONSchema;
  examples: any[];
  /** This will be used to identify this event, you should use template language but inside a double quoted string */
  key: string;
  displayProperties: (inputData: Record<string, any>) => DisplayProperties;
  matches: (data: {
    subscriptionData: Record<string, any>;
    request: WebhookIncomingRequest;
  }) => boolean;
  process: (data: WebhookReceiveRequest) => Promise<WebhookEventResult[]>;
};

export type WebhookEventMetadata = {
  description: string;
  title: string;
  tags: string[];
};

export type WebhookEventResult = {
  event: string;
  displayProperties: DisplayProperties;
  payload: any;
};

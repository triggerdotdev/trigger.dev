import { AuthCredentials } from "core/authentication/types";
import { HTTPMethod } from "core/request/types";
import { JSONSchema } from "json-schema-to-typescript";

export type Webhook = {
  id: string;
  metadata: WebhookMetadata;
  subscribe: WebhookSubscribe;
  verify: WebhookVerify;
  receive: WebhookReceive;
  events: Record<string, WebhookEvent>;
};

export type WebhookMetadata = {
  name: string;
  description: string;
  displayProperties: {
    title: string;
  };
  externalDocs?: ExternalDocs;
  tags: string[];
};

type ExternalDocs = {
  description: string;
  url: string;
};

type WebhookSpecSubscribeManual = {
  type: "manual";
};

type WebhookSpecSubscribeAutomatic = {
  type: "automatic";
  subscribe: {
    /** The action that will be called to register this webhook */
    endpoint: string;
    parameters?: Record<string, any>;
    body?: any;
  };
  //todo unsubscribe
};

export type WebhookSubscribe =
  | WebhookSpecSubscribeManual
  | WebhookSpecSubscribeAutomatic;

type WebhookRequestData = {
  request: NormalizedRequest;
  credentials?: AuthCredentials;
  secret?: string;
};

type WebhookVerifyResponse =
  | { status: "ok"; data: any }
  | { status: "ignored"; reason: string }
  | { status: "error"; error: string };

type WebhookVerify = (
  request: WebhookRequestData
) => Promise<WebhookVerifyResponse>;

//todo this will be called when receiving a request (can be verify or an actual webhook)
//the service will have to decide what to do with it
//need auth credentials
type WebhookReceive = (request: WebhookRequestData) => Promise<Event>;

type NormalizedRequest = {
  method: HTTPMethod;
  searchParams: URLSearchParams;
  headers: Record<string, string>;
  rawBody: Buffer;
  body: any;
};

type EventData = {
  payload: JSONSchema;
};

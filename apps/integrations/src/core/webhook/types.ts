import {
  AuthCredentials,
  IntegrationAuthentication,
} from "core/authentication/types";
import { EndpointSpec } from "core/endpoint/types";
import { FetchConfig, HTTPMethod } from "core/request/types";
import { JSONSchema } from "json-schema-to-typescript";

type Webhook = {
  baseUrl: string;
  spec: WebhookSpec;
  authentication: IntegrationAuthentication;
  subscribe: (
    data: WebhookSubscriptionRequest
  ) => Promise<WebhookSubscriptionResult>;
};

export type WebhookSpec = {
  id: string;
  metadata: WebhookMetadata;
  events: string[];
  subscribe: WebhookSpecSubscribe;
  // verify: WebhookVerify;
  // receive: WebhookReceive;
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

export type WebhookSpecSubscribe =
  | WebhookSpecSubscribeManual
  | WebhookSpecSubscribeAutomatic;

type WebhookSpecSubscribeManual = {
  type: "manual";
};

export interface WebhookSpecSubscribeAutomatic {
  type: "automatic";
  create: EndpointSpec;
  //todo delete: EndpointSpec;
}

export type WebhookSubscriptionRequest = {
  credentials?: AuthCredentials;
  callbackUrl: string;
  events: string[];
  secret?: string;
  data: Record<string, any>;
};

export type WebhookSubscriptionResult =
  | {
      success: true;
      callbackUrl: string;
      events: string[];
      data: any;
    }
  | {
      success: false;
      error: string;
    };

// type WebhookRequestData = {
//   request: NormalizedRequest;
//   credentials?: AuthCredentials;
//   secret?: string;
// };

// type WebhookVerifyResponse =
//   | { status: "ok"; data: any }
//   | { status: "ignored"; reason: string }
//   | { status: "error"; error: string };

// type WebhookVerify = (
//   request: WebhookRequestData
// ) => Promise<WebhookVerifyResponse>;

// //todo this will be called when receiving a request (can be verify or an actual webhook)
// //the service will have to decide what to do with it
// //need auth credentials
// type WebhookReceive = (request: WebhookRequestData) => Promise<Event>;

// type NormalizedRequest = {
//   method: HTTPMethod;
//   searchParams: URLSearchParams;
//   headers: Record<string, string>;
//   rawBody: Buffer;
//   body: any;
// };

// type EventData = {
//   payload: JSONSchema;
// };

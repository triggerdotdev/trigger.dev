import {
  ApiEventLog,
  ConnectionAuth,
  ConnectionMetadata,
  DisplayElement,
  NormalizedRequest,
  NormalizedResponse,
  SendEvent,
} from "@trigger.dev/internal";
import { TriggerClient } from "./triggerClient";

export type HttpSourceEvent = {
  request: NormalizedRequest;
  secret?: string;
};

export type SmtpSourceEvent = {
  from: string;
  to: string;
  subject: string;
  body: string;
};

export type SqsSourceEvent = {
  body: string;
};

type ExternalSourceChannelMap = {
  http: {
    event: HttpSourceEvent;
  };
  smtp: {
    event: SmtpSourceEvent;
  };
  sqs: {
    event: SqsSourceEvent;
  };
};

export type ChannelNames = keyof ExternalSourceChannelMap;

export type HandlerFunction<
  TChannel extends ChannelNames,
  TSourceEvent extends ExternalSourceChannelMap[TChannel]["event"]
> = (
  triggerClient: TriggerClient,
  event: TSourceEvent,
  auth?: ConnectionAuth
) => Promise<{ response: NormalizedResponse; events: SendEvent[] }>;

export type ExternalSourceOptions<TChannel extends ChannelNames> = {
  key: string;
  localAuth?: ConnectionAuth;
  register: (
    triggerClient: TriggerClient,
    auth?: ConnectionAuth
  ) => Promise<any>;
  handler: HandlerFunction<
    TChannel,
    ExternalSourceChannelMap[TChannel]["event"]
  >;
  eventElements?: (event: ApiEventLog) => DisplayElement[];
};

export interface AnyExternalSource {
  key: string;
  hasLocalAuth: boolean;
  connection: ConnectionMetadata;
  channel: ChannelNames;
  handler: (
    triggerClient: TriggerClient,
    event: any,
    auth?: ConnectionAuth
  ) => Promise<{ response: NormalizedResponse; events: SendEvent[] }>;
  eventElements: (event: ApiEventLog) => DisplayElement[];
  prepareForExecution: (
    client: TriggerClient,
    auth?: ConnectionAuth
  ) => Promise<void>;
}

export class ExternalSource<TChannel extends ChannelNames>
  implements AnyExternalSource
{
  channel: TChannel;
  connection: ConnectionMetadata;

  constructor(
    channel: TChannel,
    connection: ConnectionMetadata,
    private options: ExternalSourceOptions<TChannel>
  ) {
    this.channel = channel;
    this.connection = connection;
  }

  get key() {
    return this.options.key;
  }

  get hasLocalAuth() {
    return typeof this.options.localAuth !== "undefined";
  }

  async prepareForExecution(client: TriggerClient, auth?: ConnectionAuth) {
    return this.options.register(client, auth ?? this.options.localAuth);
  }

  async handler(
    triggerClient: TriggerClient,
    event: ExternalSourceChannelMap[TChannel]["event"],
    auth?: ConnectionAuth
  ) {
    return this.options.handler(
      triggerClient,
      event,
      auth ?? this.options.localAuth
    );
  }

  eventElements(event: ApiEventLog) {
    return this.options.eventElements?.(event) ?? [];
  }
}

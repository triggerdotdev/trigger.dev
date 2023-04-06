import {
  ApiEventLog,
  ConnectionAuth,
  ConnectionMetadata,
  DisplayElement,
} from "@trigger.dev/internal";
import { ClientFactory } from "./connections";
import { NormalizedRequest } from "./triggerClient";

export type RegisterSourceFunction<
  TClientType,
  TChannel extends ChannelNames,
  TOptions extends ExternalSourceChannelMap[TChannel]["registerOptions"]
> = (client: TClientType, options: TOptions) => Promise<any>;

export type HttpSourceEvent = {
  request: NormalizedRequest;
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
    registerOptions: { url: string };
  };
  smtp: {
    event: SmtpSourceEvent;
    registerOptions: { email: string };
  };
  sqs: {
    event: SqsSourceEvent;
    registerOptions: { queueUrl: string };
  };
};

export type ChannelNames = keyof ExternalSourceChannelMap;

export type HandlerFunction<
  TClientType,
  TChannel extends ChannelNames,
  TSourceEvent extends ExternalSourceChannelMap[TChannel]["event"]
> = (client: TClientType, event: TSourceEvent) => Promise<ApiEventLog[]>;

export type ExternalSourceOptions<
  TClientType,
  TChannel extends ChannelNames
> = {
  id: string;
  clientFactory: ClientFactory<TClientType>;
  register: RegisterSourceFunction<
    TClientType,
    TChannel,
    ExternalSourceChannelMap[TChannel]["registerOptions"]
  >;
  handler: HandlerFunction<
    TClientType,
    TChannel,
    ExternalSourceChannelMap[TChannel]["event"]
  >;
  eventElements?: (event: ApiEventLog) => DisplayElement[];
};

export interface AnyExternalSource {
  id: string;
  connection: ConnectionMetadata;
  channel: ChannelNames;
  register: (auth: ConnectionAuth, options: any) => Promise<any>;
  handler: (auth: ConnectionAuth, event: any) => Promise<ApiEventLog[]>;
  eventElements: (event: ApiEventLog) => DisplayElement[];
  matches: (event: ApiEventLog) => boolean;
}

export class ExternalSource<TChannel extends ChannelNames, TClientType>
  implements AnyExternalSource
{
  channel: TChannel;
  connection: ConnectionMetadata;

  constructor(
    channel: TChannel,
    connection: ConnectionMetadata,
    private options: ExternalSourceOptions<TClientType, TChannel>
  ) {
    this.channel = channel;
    this.connection = connection;
  }

  get id() {
    return this.options.id;
  }

  async register(
    auth: ConnectionAuth,
    options: ExternalSourceChannelMap[TChannel]["registerOptions"]
  ) {
    return this.options.register(this.options.clientFactory(auth), options);
  }

  async handler(
    auth: ConnectionAuth,
    event: ExternalSourceChannelMap[TChannel]["event"]
  ) {
    const client = this.options.clientFactory(auth);
    return this.options.handler(client, event);
  }

  eventElements(event: ApiEventLog) {
    return this.options.eventElements?.(event) ?? [];
  }

  matches(event: ApiEventLog) {
    return true;
  }
}

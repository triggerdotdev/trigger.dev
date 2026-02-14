import type {
  ChatRequestOptions,
  InferUIMessageChunk,
  UIMessage,
} from "ai";
import type {
  RealtimeDefinedStream,
  TriggerOptions,
} from "@trigger.dev/core/v3";

export type TriggerChatTransportTrigger =
  | "submit-message"
  | "regenerate-message";

export type TriggerChatTransportRequest<
  UI_MESSAGE extends UIMessage = UIMessage,
> = {
  chatId: string;
  trigger: TriggerChatTransportTrigger;
  messageId: string | undefined;
  messages: UI_MESSAGE[];
  request: {
    headers?: Record<string, string>;
    body?: ChatRequestOptions["body"];
    metadata?: ChatRequestOptions["metadata"];
  };
  abortSignal: AbortSignal | undefined;
};

export type TriggerChatTransportPayload<
  UI_MESSAGE extends UIMessage = UIMessage,
> = {
  chatId: string;
  trigger: TriggerChatTransportTrigger;
  messageId: string | undefined;
  messages: UI_MESSAGE[];
  request: {
    headers?: Record<string, string>;
    body?: ChatRequestOptions["body"];
    metadata?: ChatRequestOptions["metadata"];
  };
};

export type TriggerChatTaskContext<
  UI_MESSAGE extends UIMessage = UIMessage,
> = {
  payload: TriggerChatTransportPayload<UI_MESSAGE>;
  streamKey: string;
};

type MaybePromise<T> = T | Promise<T>;

export type TriggerChatPayloadMapper<
  UI_MESSAGE extends UIMessage = UIMessage,
  PAYLOAD = TriggerChatTransportPayload<UI_MESSAGE>,
> = (request: TriggerChatTransportRequest<UI_MESSAGE>) => MaybePromise<PAYLOAD>;

export type TriggerChatTriggerOptionsResolver<
  UI_MESSAGE extends UIMessage = UIMessage,
> = (
  request: TriggerChatTransportRequest<UI_MESSAGE>
) => MaybePromise<TriggerOptions | undefined>;

export type TriggerChatStream<
  UI_MESSAGE extends UIMessage = UIMessage,
> =
  | string
  | RealtimeDefinedStream<InferUIMessageChunk<UI_MESSAGE>>;

export type TriggerChatRunState = {
  chatId: string;
  runId: string;
  publicAccessToken: string;
  streamKey: string;
  lastEventId: string | undefined;
  isActive: boolean;
};

export interface TriggerChatRunStore {
  get(chatId: string): Promise<TriggerChatRunState | undefined> | TriggerChatRunState | undefined;
  set(state: TriggerChatRunState): Promise<void> | void;
  delete(chatId: string): Promise<void> | void;
}

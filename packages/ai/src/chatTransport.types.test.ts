import { expectTypeOf, it } from "vitest";
import type { InferUIMessageChunk, UIMessage } from "ai";
import {
  createTriggerChatTransport,
  TriggerChatTransport,
  InMemoryTriggerChatRunStore,
  normalizeTriggerChatHeaders,
  TriggerChatTransportOptions,
  type TriggerChatOnError,
  type TriggerChatTransportError,
  type TriggerChatHeadersInput,
  type TriggerChatReconnectOptions,
  type TriggerChatSendMessagesOptions,
  type TriggerChatTransportPayload,
  type TriggerChatTransportRequest,
  type TriggerChatRunState,
} from "./index.js";
import type { RealtimeDefinedStream } from "@trigger.dev/core/v3";

it("infers rich default payload contract", function () {
  const transport = new TriggerChatTransport({
    task: "ai-chat",
    accessToken: "pk_test",
    stream: "chat-stream",
  });

  expectTypeOf(transport).toEqualTypeOf<
    TriggerChatTransport<UIMessage, TriggerChatTransportPayload<UIMessage>>
  >();
});

it("requires payload mapper for custom payload types", function () {
  // @ts-expect-error Custom payload generic requires payloadMapper
  const invalidOptions: TriggerChatTransportOptions<UIMessage, { prompt: string }> = {
    task: "ai-chat",
    accessToken: "pk_test",
    stream: "chat-stream",
  };

  expectTypeOf(invalidOptions).toBeObject();
});

it("types mapper input with rich request context", function () {
  const options: TriggerChatTransportOptions<
    UIMessage,
    { prompt: string; chatId: string; source: string | undefined }
  > = {
    task: "ai-chat",
    accessToken: "pk_test",
    stream: "chat-stream",
    payloadMapper: function payloadMapper(request: TriggerChatTransportRequest<UIMessage>) {
      const firstMessage = request.messages[0];
      const firstPart = firstMessage?.parts[0];
      const prompt =
        firstPart && firstPart.type === "text"
          ? firstPart.text
          : "";

      return {
        prompt,
        chatId: request.chatId,
        source: request.request.headers?.["x-source"],
      };
    },
    onTriggeredRun: function onTriggeredRun(state: TriggerChatRunState) {
      expectTypeOf(state.chatId).toEqualTypeOf<string>();
      expectTypeOf(state.publicAccessToken).toEqualTypeOf<string>();
    },
  };

  expectTypeOf(options.payloadMapper).toBeFunction();
});

it("accepts async payload mappers and trigger option resolvers", function () {
  const options: TriggerChatTransportOptions<
    UIMessage,
    { prompt: string; chatId: string }
  > = {
    task: "ai-chat",
    accessToken: "pk_test",
    payloadMapper: async function payloadMapper(request) {
      return {
        prompt: request.chatId,
        chatId: request.chatId,
      };
    },
    triggerOptions: async function triggerOptions(request) {
      return {
        queue: `queue-${request.chatId}`,
      };
    },
    onTriggeredRun: async function onTriggeredRun(_state) {
      return;
    },
    onError: async function onError(_error: TriggerChatTransportError) {
      return;
    },
  };

  expectTypeOf(options).toBeObject();
});

it("exposes strongly typed onError callback payloads", function () {
  const onError = createTypedOnErrorCallback();

  expectTypeOf(onError).toBeFunction();
});

function createTypedOnErrorCallback(): TriggerChatOnError {
  async function onError(error: TriggerChatTransportError) {
    expectTypeOf(error.phase).toEqualTypeOf<"onTriggeredRun" | "consumeTrackingStream" | "reconnect">();
    expectTypeOf(error.chatId).toEqualTypeOf<string>();
    expectTypeOf(error.runId).toEqualTypeOf<string>();
    expectTypeOf(error.error).toEqualTypeOf<Error>();
  }

  return onError;
}

it("infers custom payload output from mapper in factory helper", function () {
  const transport = createTriggerChatTransport({
    task: "ai-chat",
    accessToken: "pk_test",
    payloadMapper: function payloadMapper(request) {
      return {
        prompt: request.chatId,
      };
    },
  });

  expectTypeOf(transport).toEqualTypeOf<
    TriggerChatTransport<UIMessage, { prompt: string }>
  >();
});

it("accepts typed stream definition objects", function () {
  const typedStream = {
    id: "chat-stream",
    pipe: async function pipe() {
      throw new Error("not used in type test");
    },
  } as unknown as RealtimeDefinedStream<InferUIMessageChunk<UIMessage>>;

  const transport = new TriggerChatTransport({
    task: "ai-chat",
    accessToken: "pk_test",
    stream: typedStream,
  });

  expectTypeOf(transport).toBeObject();
});

it("accepts tuple-style headers in sendMessages options", function () {
  const transport = new TriggerChatTransport({
    task: "ai-chat",
    accessToken: "pk_test",
  });

  const headersInput: TriggerChatHeadersInput = [["x-header", "x-value"]];

  const sendOptions: TriggerChatSendMessagesOptions<UIMessage> = {
    trigger: "submit-message",
    chatId: "chat_123",
    messageId: undefined,
    messages: [],
    abortSignal: undefined,
    headers: headersInput,
  };

  const reconnectOptions: TriggerChatReconnectOptions = {
    chatId: "chat_123",
    headers: headersInput,
  };

  type SendMessagesParams = Parameters<typeof transport.sendMessages>[0];
  const tupleHeaders: SendMessagesParams["headers"] = sendOptions.headers;
  expectTypeOf(reconnectOptions).toBeObject();
  expectTypeOf(transport.sendMessages).toBeFunction();
  void tupleHeaders;
});

it("accepts custom run store implementations via options typing", function () {
  const runStore = new InMemoryTriggerChatRunStore();
  const transport = new TriggerChatTransport({
    task: "ai-chat",
    accessToken: "pk_test",
    runStore,
  });

  expectTypeOf(transport).toBeObject();
});

it("accepts custom onError callbacks via options typing", function () {
  const transport = new TriggerChatTransport({
    task: "ai-chat",
    accessToken: "pk_test",
    onError: function onError(error) {
      expectTypeOf(error.chatId).toEqualTypeOf<string>();
      expectTypeOf(error.runId).toEqualTypeOf<string>();
    },
  });

  expectTypeOf(transport).toBeObject();
});

it("exports typed header normalization helper", function () {
  const normalizedHeaders = normalizeTriggerChatHeaders({
    "x-header": "value",
  });

  expectTypeOf(normalizedHeaders).toEqualTypeOf<Record<string, string> | undefined>();
});

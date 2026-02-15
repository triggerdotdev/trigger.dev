import { expectTypeOf, it } from "vitest";
import type { InferUIMessageChunk, UIMessage } from "ai";
import {
  TriggerChatTransport,
  TriggerChatTransportOptions,
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
  };

  expectTypeOf(options).toBeObject();
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

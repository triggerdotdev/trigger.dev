import {
  ApiClient,
  ApiRequestOptions,
  makeIdempotencyKey,
  SSEStreamPart,
  SSEStreamSubscription,
  stringifyIO,
  TriggerOptions,
} from "@trigger.dev/core/v3";
import type {
  ChatTransport,
  InferUIMessageChunk,
  UIMessage,
  UIMessageChunk,
} from "ai";
import type {
  TriggerChatHeadersInput,
  TriggerChatReconnectOptions,
  TriggerChatSendMessagesOptions,
  TriggerChatOnTriggeredRun,
  TriggerChatPayloadMapper,
  TriggerChatRunState,
  TriggerChatRunStore,
  TriggerChatStream,
  TriggerChatTaskContext,
  TriggerChatTransportPayload,
  TriggerChatTransportRequest,
  TriggerChatTriggerOptionsResolver,
} from "./types.js";

type TriggerTaskResponse = {
  id: string;
  publicAccessToken: string;
};

type TriggerTaskRequestOptions = {
  queue?: {
    name: string;
  };
  concurrencyKey?: string;
  payloadType?: string;
  idempotencyKey?: string;
  idempotencyKeyTTL?: string;
  delay?: string | Date;
  ttl?: string | number;
  tags?: string | string[];
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
  maxDuration?: number;
  lockToVersion?: string;
  priority?: number;
  region?: string;
  machine?: string;
  debounce?: {
    key: string;
    delay: string;
    mode?: "leading" | "trailing";
    maxDelay?: string;
  };
};

type TriggerTaskRequestBody = {
  payload?: string;
  options?: TriggerTaskRequestOptions;
};

type TriggerChatTransportCommonOptions<
  UI_MESSAGE extends UIMessage = UIMessage,
> = {
  task: string;
  accessToken: string;
  stream?: TriggerChatStream<UI_MESSAGE>;
  baseURL?: string;
  previewBranch?: string;
  requestOptions?: ApiRequestOptions;
  timeoutInSeconds?: number;
  triggerOptions?:
    | TriggerOptions
    | TriggerChatTriggerOptionsResolver<UI_MESSAGE>;
  runStore?: TriggerChatRunStore;
  onTriggeredRun?: TriggerChatOnTriggeredRun;
};

type TriggerChatTransportMapperRequirement<
  UI_MESSAGE extends UIMessage,
  PAYLOAD,
> = PAYLOAD extends TriggerChatTransportPayload<UI_MESSAGE>
  ? {
      payloadMapper?: TriggerChatPayloadMapper<UI_MESSAGE, PAYLOAD>;
    }
  : {
      payloadMapper: TriggerChatPayloadMapper<UI_MESSAGE, PAYLOAD>;
    };

export type TriggerChatTransportOptions<
  UI_MESSAGE extends UIMessage = UIMessage,
  PAYLOAD = TriggerChatTransportPayload<UI_MESSAGE>,
> = TriggerChatTransportCommonOptions<UI_MESSAGE> &
  TriggerChatTransportMapperRequirement<UI_MESSAGE, PAYLOAD>;

export class InMemoryTriggerChatRunStore implements TriggerChatRunStore {
  private readonly runs = new Map<string, TriggerChatRunState>();

  public get(chatId: string): TriggerChatRunState | undefined {
    return this.runs.get(chatId);
  }

  public set(state: TriggerChatRunState): void {
    this.runs.set(state.chatId, state);
  }

  public delete(chatId: string): void {
    this.runs.delete(chatId);
  }
}

export class TriggerChatTransport<
    UI_MESSAGE extends UIMessage = UIMessage,
    PAYLOAD = TriggerChatTransportPayload<UI_MESSAGE>,
  >
  implements ChatTransport<UI_MESSAGE>
{
  private readonly task: string;
  private readonly streamKey: string;
  private readonly timeoutInSeconds: number;
  private readonly payloadMapper: TriggerChatPayloadMapper<UI_MESSAGE, PAYLOAD>;
  private readonly triggerOptions?:
    | TriggerOptions
    | TriggerChatTriggerOptionsResolver<UI_MESSAGE>;
  private readonly runStore: TriggerChatRunStore;
  private readonly triggerClient: ApiClient;
  private readonly baseURL: string;
  private readonly previewBranch: string | undefined;
  private readonly requestOptions: ApiRequestOptions | undefined;
  private readonly onTriggeredRun: TriggerChatOnTriggeredRun | undefined;

  constructor(options: TriggerChatTransportOptions<UI_MESSAGE, PAYLOAD>) {
    this.task = options.task;
    this.streamKey = resolveStreamKey<UI_MESSAGE>(options.stream);
    this.timeoutInSeconds = options.timeoutInSeconds ?? 60;
    this.payloadMapper = resolvePayloadMapper<UI_MESSAGE, PAYLOAD>(options.payloadMapper);
    this.triggerOptions = options.triggerOptions;
    this.runStore = options.runStore ?? new InMemoryTriggerChatRunStore();
    this.baseURL = options.baseURL ?? "https://api.trigger.dev";
    this.previewBranch = options.previewBranch;
    this.requestOptions = options.requestOptions;
    this.triggerClient = new ApiClient(
      this.baseURL,
      options.accessToken,
      this.previewBranch,
      this.requestOptions
    );
    this.onTriggeredRun = options.onTriggeredRun;
  }

  public async sendMessages(
    options: TriggerChatSendMessagesOptions<UI_MESSAGE>
  ): Promise<ReadableStream<UIMessageChunk>> {
    const transportRequest = createTransportRequest<UI_MESSAGE>(options);
    const payload = await this.payloadMapper(transportRequest);
    const triggerOptions = await resolveTriggerOptions<UI_MESSAGE>(
      this.triggerOptions,
      transportRequest
    );
    const run = await this.triggerTask(payload, triggerOptions);

    const runState: TriggerChatRunState = {
      chatId: options.chatId,
      runId: run.id,
      publicAccessToken: run.publicAccessToken,
      streamKey: this.streamKey,
      lastEventId: undefined,
      isActive: true,
    };

    await this.runStore.set(runState);

    if (this.onTriggeredRun) {
      try {
        await this.onTriggeredRun(runState);
      } catch {
        // Ignore callback errors so chat streaming can continue.
      }
    }

    const stream = await this.fetchRunStream(runState, options.abortSignal);

    return this.createTrackedStream(runState.chatId, stream);
  }

  public async reconnectToStream(
    options: TriggerChatReconnectOptions
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const runState = await this.runStore.get(options.chatId);

    if (!runState || !runState.isActive) {
      return null;
    }

    let stream: ReadableStream<SSEStreamPart<InferUIMessageChunk<UI_MESSAGE>>>;
    try {
      stream = await this.fetchRunStream(runState, undefined, runState.lastEventId);
    } catch {
      runState.isActive = false;
      await this.runStore.set(runState);
      await this.runStore.delete(options.chatId);
      return null;
    }

    return this.createTrackedStream(runState.chatId, stream);
  }

  private async fetchRunStream(
    runState: TriggerChatRunState,
    abortSignal: AbortSignal | undefined,
    lastEventId?: string
  ): Promise<ReadableStream<SSEStreamPart<InferUIMessageChunk<UI_MESSAGE>>>> {
    const streamClient = new ApiClient(
      this.baseURL,
      runState.publicAccessToken,
      this.previewBranch,
      this.requestOptions
    );

    const subscription = new SSEStreamSubscription(
      this.createStreamUrl(runState.runId, runState.streamKey),
      {
        headers: streamClient.getHeaders(),
        signal: abortSignal,
        timeoutInSeconds: this.timeoutInSeconds,
        lastEventId,
      }
    );

    return (await subscription.subscribe()) as ReadableStream<
      SSEStreamPart<InferUIMessageChunk<UI_MESSAGE>>
    >;
  }

  private createTrackedStream(
    chatId: string,
    stream: ReadableStream<SSEStreamPart<InferUIMessageChunk<UI_MESSAGE>>>
  ) {
    const teeStreams = stream.tee();
    const trackingStream = teeStreams[0];
    const consumerStream = teeStreams[1];

    this.consumeTrackingStream(chatId, trackingStream);

    return consumerStream.pipeThrough(
      new TransformStream<SSEStreamPart<InferUIMessageChunk<UI_MESSAGE>>, UIMessageChunk>({
        transform(part, controller) {
          controller.enqueue(part.chunk as UIMessageChunk);
        },
      })
    );
  }

  private async consumeTrackingStream(
    chatId: string,
    stream: ReadableStream<SSEStreamPart<InferUIMessageChunk<UI_MESSAGE>>>
  ) {
    try {
      for await (const part of stream) {
        const runState = await this.runStore.get(chatId);

        if (!runState) {
          return;
        }

        runState.lastEventId = part.id;
        await this.runStore.set(runState);
      }

      const runState = await this.runStore.get(chatId);
      if (runState) {
        runState.isActive = false;
        await this.runStore.set(runState);
        await this.runStore.delete(chatId);
      }
    } catch {
      const runState = await this.runStore.get(chatId);
      if (runState) {
        runState.isActive = false;
        await this.runStore.set(runState);
        await this.runStore.delete(chatId);
      }
    }
  }

  private async triggerTask(payload: PAYLOAD, options: TriggerOptions | undefined) {
    const payloadPacket = await stringifyIO(payload);
    const requestBody: TriggerTaskRequestBody = {
      payload: payloadPacket.data,
      options: await createTriggerTaskOptions(payloadPacket.dataType, options),
    };

    const handle = await this.triggerClient.triggerTask(this.task, requestBody as never);

    return handle as TriggerTaskResponse;
  }

  private createStreamUrl(runId: string, streamKey: string): string {
    const normalizedBaseUrl = this.baseURL.replace(/\/$/, "");
    const encodedRunId = encodeURIComponent(runId);
    const encodedStreamKey = encodeURIComponent(streamKey);

    return `${normalizedBaseUrl}/realtime/v1/streams/${encodedRunId}/${encodedStreamKey}`;
  }
}

export function createTriggerChatTransport<
  UI_MESSAGE extends UIMessage = UIMessage,
  PAYLOAD = TriggerChatTransportPayload<UI_MESSAGE>,
>(
  options: TriggerChatTransportOptions<UI_MESSAGE, PAYLOAD>
) {
  return new TriggerChatTransport<UI_MESSAGE, PAYLOAD>(options);
}

function resolvePayloadMapper<
  UI_MESSAGE extends UIMessage,
  PAYLOAD,
>(payloadMapper: TriggerChatPayloadMapper<UI_MESSAGE, PAYLOAD> | undefined) {
  if (payloadMapper) {
    return payloadMapper;
  }

  return createDefaultPayload as TriggerChatPayloadMapper<UI_MESSAGE, PAYLOAD>;
}

function createTransportRequest<UI_MESSAGE extends UIMessage>(
  options: TriggerChatSendMessagesOptions<UI_MESSAGE>
): TriggerChatTransportRequest<UI_MESSAGE> {
  return {
    chatId: options.chatId,
    trigger: options.trigger,
    messageId: options.messageId,
    messages: options.messages,
    request: {
      headers: normalizeHeaders(options.headers),
      body: options.body,
      metadata: options.metadata,
    },
    abortSignal: options.abortSignal,
  };
}

function createDefaultPayload<UI_MESSAGE extends UIMessage>(
  request: TriggerChatTransportRequest<UI_MESSAGE>
): TriggerChatTransportPayload<UI_MESSAGE> {
  return {
    chatId: request.chatId,
    trigger: request.trigger,
    messageId: request.messageId,
    messages: request.messages,
    request: {
      headers: request.request.headers,
      body: request.request.body,
      metadata: request.request.metadata,
    },
  };
}

function resolveStreamKey<UI_MESSAGE extends UIMessage>(
  stream: TriggerChatStream<UI_MESSAGE> | undefined
) {
  if (!stream) {
    return "default";
  }

  if (typeof stream === "string") {
    return stream;
  }

  return stream.id;
}

function normalizeHeaders(
  headers: TriggerChatHeadersInput | undefined
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  if (Array.isArray(headers)) {
    const result: Record<string, string> = {};
    for (const [key, value] of headers) {
      result[key] = value;
    }
    return result;
  }

  if (isHeadersInstance(headers)) {
    const result: Record<string, string> = {};
    for (const [key, value] of headers.entries()) {
      result[key] = value;
    }
    return result;
  }

  const headersRecord = headers as Record<string, string>;
  const result: Record<string, string> = {};
  for (const key of Object.keys(headersRecord)) {
    const value = headersRecord[key];
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  return result;
}

function isHeadersInstance(headers: unknown): headers is Headers {
  if (typeof Headers === "undefined") {
    return false;
  }

  return headers instanceof Headers;
}

async function resolveTriggerOptions<UI_MESSAGE extends UIMessage>(
  options:
    | TriggerOptions
    | TriggerChatTriggerOptionsResolver<UI_MESSAGE>
    | undefined,
  request: TriggerChatTransportRequest<UI_MESSAGE>
) {
  if (!options) {
    return undefined;
  }

  if (typeof options === "function") {
    return await options(request);
  }

  return options;
}

async function createTriggerTaskOptions(
  payloadType: string | undefined,
  triggerOptions: TriggerOptions | undefined
): Promise<TriggerTaskRequestOptions> {
  return {
    queue: triggerOptions?.queue ? { name: triggerOptions.queue } : undefined,
    concurrencyKey: triggerOptions?.concurrencyKey,
    payloadType,
    idempotencyKey: await makeIdempotencyKey(triggerOptions?.idempotencyKey),
    idempotencyKeyTTL: triggerOptions?.idempotencyKeyTTL,
    delay: triggerOptions?.delay,
    ttl: triggerOptions?.ttl,
    tags: triggerOptions?.tags,
    maxAttempts: triggerOptions?.maxAttempts,
    metadata: triggerOptions?.metadata,
    maxDuration: triggerOptions?.maxDuration,
    lockToVersion: triggerOptions?.version,
    priority: triggerOptions?.priority,
    region: triggerOptions?.region,
    machine: triggerOptions?.machine,
    debounce: triggerOptions?.debounce,
  };
}

export type { TriggerChatTaskContext };

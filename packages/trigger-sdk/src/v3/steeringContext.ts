import type { ModelMessage, UIMessage } from "ai";
import { BACKGROUND_INJECTION_TYPE, PENDING_MESSAGE_INJECTED_TYPE } from "./ai-shared.js";

/** Private model forms, keyed by the durable UI injection marker. */
export type SteeringInjection = {
  id: string;
  messageIds: string[];
  messages: ModelMessage[];
  /** `background` for `chat.inject` drained mid-turn; absent means steering. */
  kind?: "steering" | "background";
  /** Inputs removed by snapshot retention, not an explicit history edit. */
  trimmedMessageIds?: string[];
};

type StepWithResponse = { response: { messages: ModelMessage[] } };

/** What prepareStep receives from the AI SDK, as far as these helpers read it. */
type GenerationInput = {
  steps: readonly StepWithResponse[];
  /** Passed from AI SDK 7: every response message of the generation so far. */
  responseMessages?: ModelMessage[];
};

type StepInput = GenerationInput & {
  messages: ModelMessage[];
  steps: StepWithResponse[];
};

/**
 * A message as JSON text, or null when JSON cannot hold it. The input an override
 * is retained from is the AI SDK's own, so a tool result in it can still hold a
 * BigInt or a circular reference. Plain `JSON.stringify` is tried first, since a
 * replacer function takes it off V8's fast path and tool results can be large;
 * only a BigInt (a TypeError) retries with the BigInt encoded by value, as an
 * object a string cannot equal. Anything still unserializable is null.
 */
function serializeMessage(message: ModelMessage): string | null {
  try {
    return JSON.stringify(message);
  } catch {
    try {
      return JSON.stringify(message, (_key, value) =>
        typeof value === "bigint" ? { $bigint: value.toString() } : value
      );
    } catch {
      return null;
    }
  }
}

/**
 * Every response message of the generation so far, oldest first, taken from
 * what the AI SDK hands prepareStep rather than inferred from the steps.
 *
 * AI SDK 7 passes it as `responseMessages`, and its steps each carry only
 * their own messages. Up to AI SDK 6 there is no such argument, but each
 * step's `response.messages` already holds every response message so far, so
 * the last step's is the list (a step that adds nothing leaves it as it was).
 * Telling the two apart from the steps' contents is ambiguous, which is why
 * neither is guessed. A major that changes this again fails the per-major
 * tests.
 */
export function generationResponseMessages(input: GenerationInput): ModelMessage[] {
  return input.responseMessages ?? input.steps.at(-1)?.response.messages ?? [];
}

/**
 * Keeps a prepareStep override in place for the rest of the generation.
 *
 * Once a step's prepareStep returns `messages` (a steer, an injection, a
 * compaction, tool results put back in call order), every later step's input
 * is that override plus the response messages added since, counted against
 * `generationResponseMessages`. AI SDK 5/6 rebuild each step's input from the
 * original prompt and would drop the override; AI SDK 7 carries it forward
 * itself, and this builds the same input it would. State belongs to one
 * generation, not one turn.
 *
 * Response messages can already be in the input an override was retained from:
 * tool calls approved before the first step (a head-start handover) are executed
 * up front, and their results open both that input and every later step's
 * response messages. Those are skipped, so each result is sent once.
 */
export function retainStepMessages<T extends StepInput, R extends { messages?: ModelMessage[] }>(
  prepare: (input: T) => Promise<R | undefined>
): (input: T) => Promise<R | undefined> {
  let retained: ModelMessage[] | undefined;
  let retainedFrom: ModelMessage[] | undefined;
  let previousSteps = -1;
  /** How many of the generation's response messages the last call saw. */
  let seen = 0;
  return async (input) => {
    if (input.steps.length <= previousSteps) {
      retained = undefined;
      retainedFrom = undefined;
      seen = 0;
    }
    const responses = generationResponseMessages(input);
    let fresh = responses.slice(seen);
    if (retainedFrom) {
      fresh = fresh.slice(alreadyIncluded(retainedFrom, fresh));
      retainedFrom = undefined;
    }
    const messages = retained ? [...retained, ...fresh] : input.messages;
    const result = await prepare({ ...input, messages });
    if (!retained && result?.messages) retainedFrom = input.messages;
    retained = result?.messages ?? (retained ? messages : undefined);
    seen = responses.length;
    previousSteps = input.steps.length;
    return retained ? ({ ...result, messages: retained } as R) : result;
  };
}

/**
 * How many of `next` already end `input`, as the longest overlap.
 *
 * A message is the same as another when it is the same object or both serialize
 * to the same JSON. One that JSON cannot hold counts as different, so it is not
 * de-duplicated: a head-start tool result with a circular reference is sent
 * twice, which is rare and better than a failed step. Each message is
 * serialized at most once, so the cost is linear in the messages' size rather
 * than once per overlap length tried.
 */
function alreadyIncluded(input: ModelMessage[], next: ModelMessage[]): number {
  const serialized = new Map<ModelMessage, string | null>();
  const json = (message: ModelMessage) => {
    let text = serialized.get(message);
    if (text === undefined) {
      text = serializeMessage(message);
      serialized.set(message, text);
    }
    return text;
  };
  const same = (a: ModelMessage, b: ModelMessage) => {
    if (a === b) return true;
    if (a.role !== b.role) return false;
    const text = json(a);
    return text !== null && text === json(b);
  };
  for (let count = Math.min(input.length, next.length); count > 0; count--) {
    const start = input.length - count;
    let matches = true;
    for (let i = 0; i < count && matches; i++) matches = same(input[start + i]!, next[i]!);
    if (matches) return count;
  }
  return 0;
}

const isInjectionMarker = (part: { type: string }) =>
  part.type === PENDING_MESSAGE_INJECTED_TYPE || part.type === BACKGROUND_INJECTION_TYPE;

/** Drop injection marker parts; only the agent's own assistant messages carry them. */
export function withoutInjectionMarkers<T extends UIMessage>(message: T): T {
  return message.parts.some(isInjectionMarker)
    ? { ...message, parts: message.parts.filter((part) => !isInjectionMarker(part)) }
    : message;
}

/** Injection markers, read from assistant messages only. */
export function steeringMarkers(messages: readonly UIMessage[]) {
  return messages.flatMap((message) =>
    (message.role === "assistant" ? message.parts : []).flatMap((part) => {
      if (part.type !== PENDING_MESSAGE_INJECTED_TYPE && part.type !== BACKGROUND_INJECTION_TYPE)
        return [];
      const p = part as {
        id?: string;
        data?: { messageIds?: string[]; messages?: Array<{ id: string; text: string }> };
      };
      return typeof p.id === "string" && Array.isArray(p.data?.messageIds)
        ? [
            {
              id: p.id,
              messageIds: p.data.messageIds,
              messages: p.data.messages ?? [],
              kind:
                part.type === BACKGROUND_INJECTION_TYPE
                  ? ("background" as const)
                  : ("steering" as const),
            },
          ]
        : [];
    })
  );
}

/**
 * Project an inline UI event into a real model-message boundary. The public
 * assistant keeps its identity; the model sees complete preceding tool steps,
 * then the exact prepared input, then the subsequent assistant steps.
 */
export async function convertSteeredMessages(
  messages: UIMessage[],
  convert: (messages: UIMessage[]) => Promise<ModelMessage[]>,
  injections: ReadonlyMap<string, SteeringInjection>,
  context: readonly UIMessage[] = messages,
  requireInputPresence = false
): Promise<ModelMessage[]> {
  const markers = steeringMarkers([...context, ...messages]);
  if (markers.length === 0 && injections.size === 0) return convert(messages);
  const inlineIds = new Set(markers.flatMap((marker) => marker.messageIds));
  const uiById = new Map([...context, ...messages].map((message) => [message.id, message]));
  const out: ModelMessage[] = [];
  const standalone = new Map(
    [...injections.values()].flatMap((entry) => entry.messageIds.map((id) => [id, entry] as const))
  );
  const emitted = new Set<string>();
  let batch: UIMessage[] = [];
  const flush = async () => {
    if (batch.length) out.push(...(await convert(batch)));
    batch = [];
  };
  for (const message of messages) {
    if (inlineIds.has(message.id)) continue;
    const preparedInput = standalone.get(message.id);
    if (preparedInput) {
      await flush();
      if (!emitted.has(preparedInput.id)) out.push(...preparedInput.messages);
      emitted.add(preparedInput.id);
      continue;
    }
    if (message.role !== "assistant") {
      batch.push(message);
      continue;
    }
    let parts: UIMessage["parts"] = [];
    for (const part of message.parts) {
      const marker = steeringMarkers([{ ...message, parts: [part] }])[0];
      if (!marker) {
        parts.push(part);
        continue;
      }
      if (parts.length) batch.push({ ...message, parts });
      parts = [];
      await flush();
      // An explicit history edit removing input is authoritative. The UI
      // marker can still describe what happened, without resurrecting it in
      // future model context from its fallback text or private prepared form.
      const prepared = injections.get(marker.id);
      if (
        requireInputPresence &&
        !marker.messageIds.every(
          (id) => uiById.has(id) || prepared?.trimmedMessageIds?.includes(id)
        )
      )
        continue;
      if (prepared) out.push(...prepared.messages);
      else {
        // Old/custom stores may have only the UI transcript. Recover ordinary
        // user input, never expose the private model forms in the marker.
        const users = marker.messageIds.flatMap((id) => {
          const ui = uiById.get(id);
          if (ui) return [ui];
          const text = marker.messages.find((m) => m.id === id)?.text;
          return text === undefined
            ? []
            : [{ id, role: "user" as const, parts: [{ type: "text" as const, text }] }];
        });
        if (users.length) out.push(...(await convert(users)));
      }
    }
    if (parts.length) batch.push({ ...message, parts });
  }
  await flush();
  return out;
}

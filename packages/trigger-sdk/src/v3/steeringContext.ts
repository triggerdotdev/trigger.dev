import type { ModelMessage, UIMessage } from "ai";
import { PENDING_MESSAGE_INJECTED_TYPE } from "./ai-shared.js";

/** Private model forms, keyed by the durable UI injection marker. */
export type SteeringInjection = {
  id: string;
  messageIds: string[];
  messages: ModelMessage[];
  /** Inputs removed by snapshot retention, not an explicit history edit. */
  trimmedMessageIds?: string[];
};

type StepInput = {
  messages: ModelMessage[];
  steps: Array<{ response: { messages: ModelMessage[] } }>;
};

/**
 * AI SDK 5/6 rebuild input from the original prompt on every step. Retain an
 * override and append only the newly completed response messages. The same
 * logic works when the installed AI SDK already retains overrides: its input
 * is not concatenated again. State belongs to one generation, not one turn.
 */
export function retainStepMessages<T extends StepInput, R extends { messages?: ModelMessage[] }>(
  prepare: (input: T) => Promise<R | undefined>
): (input: T) => Promise<R | undefined> {
  let retained: ModelMessage[] | undefined;
  let responseCount = 0;
  let previousSteps = -1;
  return async (input) => {
    if (input.steps.length <= previousSteps) {
      retained = undefined;
      responseCount = 0;
    }
    const responses = input.steps.at(-1)?.response.messages ?? [];
    const messages = retained ? [...retained, ...responses.slice(responseCount)] : input.messages;
    const result = await prepare({ ...input, messages });
    retained = result?.messages ?? (retained ? messages : undefined);
    responseCount = responses.length;
    previousSteps = input.steps.length;
    return retained ? ({ ...result, messages: retained } as R) : result;
  };
}

export function steeringMarkers(messages: readonly UIMessage[]) {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== PENDING_MESSAGE_INJECTED_TYPE) return [];
      const p = part as {
        id?: string;
        data?: { messageIds?: string[]; messages?: Array<{ id: string; text: string }> };
      };
      return typeof p.id === "string" && Array.isArray(p.data?.messageIds)
        ? [{ id: p.id, messageIds: p.data.messageIds, messages: p.data.messages ?? [] }]
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

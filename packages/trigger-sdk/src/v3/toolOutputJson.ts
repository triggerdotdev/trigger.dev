import { logger } from "@trigger.dev/core/v3";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";

/** What a tool output became: its JSON value, or why it has none. */
type Checked = { value: unknown } | { problem: string };
type Inspection = { convert: boolean; issue?: { kind: string; keys: (string | number)[] } };

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const formatPath = (keys: (string | number)[]) =>
  keys.reduce<string>(
    (path, key) =>
      typeof key === "number"
        ? `${path}[${key}]`
        : IDENTIFIER.test(key)
          ? path
            ? `${path}.${key}`
            : key
          : `${path}[${JSON.stringify(key)}]`,
    ""
  ) || "the top level";

/**
 * Walks a value once, without copying it. Returns the first value JSON cannot
 * hold with the keys leading to it, and sets `convert` when a JSON round trip
 * would change the value (a `Date`, anything with `toJSON`, `undefined`, a
 * non-finite number, a class instance, a sparse array).
 *
 * Kept lean: keys are pushed and popped and only joined into a path on failure,
 * and only the chain of ancestors is kept, so an object referenced twice is not
 * taken for a cycle.
 */
function inspect(root: unknown): Inspection {
  const ancestors: object[] = [];
  const keys: (string | number)[] = [];
  let convert = false;
  const visit = (value: unknown): string | undefined => {
    switch (typeof value) {
      case "string":
      case "boolean":
        return undefined;
      case "number":
        if (!Number.isFinite(value)) convert = true;
        return undefined;
      case "bigint":
        // An app can give BigInt a `toJSON` (an ORM's BigInt ids), which
        // `JSON.stringify`, and so the AI SDK, then honours.
        if (typeof (BigInt.prototype as { toJSON?: unknown }).toJSON === "function") {
          convert = true;
          return undefined;
        }
        return "BigInt";
      case "undefined":
      case "function":
      case "symbol":
        convert = true;
        return undefined;
    }
    if (value === null) return undefined;
    const object = value as Record<string, unknown>;
    if (ancestors.includes(object)) return "circular reference";
    if (typeof object.toJSON === "function") {
      convert = true;
      return undefined;
    }
    ancestors.push(object);
    if (Array.isArray(object)) {
      for (let index = 0; index < object.length; index++) {
        if (!(index in object)) convert = true;
        keys.push(index);
        const kind = visit(object[index]);
        if (kind) return kind;
        keys.pop();
      }
    } else {
      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) convert = true;
      for (const key in object) {
        if (!Object.hasOwn(object, key)) continue;
        keys.push(key);
        const kind = visit(object[key]);
        if (kind) return kind;
        keys.pop();
      }
    }
    ancestors.pop();
    return undefined;
  };
  const kind = visit(root);
  return kind ? { convert, issue: { kind, keys } } : { convert };
}

function check(value: unknown): Checked {
  const { issue, convert } = inspect(value);
  let problem: string | undefined;
  if (issue) {
    problem = `${issue.kind} at ${formatPath(issue.keys)}`;
  } else if (convert) {
    try {
      // Same conversion as the AI SDK's own from 7.0.101: a Date becomes its ISO string.
      const serialized = JSON.stringify(value);
      return { value: serialized === undefined ? null : JSON.parse(serialized) };
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
  } else {
    return { value };
  }
  return { problem };
}

const unserializableMessage = (toolName: string, problem: string) =>
  `Tool "${toolName}" returned a value that cannot be sent to the model as JSON: ${problem}. ` +
  "Convert it in the tool's execute before returning it, for example to a string or a number.";

/**
 * Tool outputs already checked, and what each became, per tool call. AI SDK
 * versions that keep the raw output pass the same object on every later
 * conversion and step, so each result is walked, and converted, once per run
 * however often the history is rebuilt. The tool call is part of the key because
 * a tool can return the same object from several calls, changed in between (a
 * shared state object): each call keeps the value it returned, as the AI SDK's
 * own conversion from 7.0.101 does. Outputs are held weakly: entries go with them.
 */
const checked = new WeakMap<object, Map<string, Checked>>();

/**
 * Calls remembered per output, oldest dropped first. Bounds what an object that
 * outlives its run (a module-level value returned by every call, in a reused
 * process) keeps; a dropped call is only checked again.
 */
const MAX_CALLS_PER_OUTPUT = 64;

/**
 * The cached verdict for one call's output, logging a problem the first time it
 * is found. A bare value such as a top-level `BigInt` cannot be cached, so it is
 * checked, and logged, on every conversion.
 */
function checkedOutput(value: unknown, part: ToolResultPart): Checked {
  if (typeof value !== "object" || value === null) return reported(check(value), part);
  let calls = checked.get(value);
  if (!calls) checked.set(value, (calls = new Map()));
  let result = calls.get(part.toolCallId);
  if (!result) {
    calls.set(part.toolCallId, (result = reported(check(value), part)));
    if (calls.size > MAX_CALLS_PER_OUTPUT) calls.delete(calls.keys().next().value!);
  }
  return result;
}

function reported(result: Checked, part: ToolResultPart): Checked {
  if ("problem" in result) logger.error(unserializableMessage(part.toolName, result.problem));
  return result;
}

let sdkConvertsToolOutputs: Promise<boolean> | undefined;

/**
 * Whether the installed AI SDK turns tool outputs into plain JSON itself, as it
 * does from 7.0.101. Asked once per process by converting one tool part holding a
 * `Date`, so it follows what the SDK does rather than its version number. Where
 * it does, a `toModelOutput` returning `{ type: "json" }` is left as the tool
 * built it, as the SDK itself leaves it.
 */
function aiSdkConvertsToolOutputs(): Promise<boolean> {
  sdkConvertsToolOutputs ??= (async () => {
    const probe = {
      id: "probe",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "probe",
          toolCallId: "probe",
          state: "output-available",
          input: {},
          output: new Date(0),
        },
      ],
    } as UIMessage;
    try {
      const converted = await convertToModelMessages([probe]);
      const result = converted
        .flatMap((message): unknown[] => (Array.isArray(message.content) ? message.content : []))
        .find((part) => isJsonToolResult(part));
      return typeof (result as ToolResultPart | undefined)?.output.value === "string";
    } catch {
      return false;
    }
  })();
  return sdkConvertsToolOutputs;
}

type ToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: string; value?: unknown };
};

const isJsonToolResult = (part: unknown): part is ToolResultPart => {
  const candidate = part as Partial<ToolResultPart> | null;
  return (
    candidate?.type === "tool-result" &&
    (candidate.output?.type === "json" || candidate.output?.type === "error-json")
  );
};

/**
 * Makes every JSON tool result in `messages` plain JSON, the shape the AI SDK
 * validates a prompt against. Applied to the stored history between calls and,
 * through the managed `prepareStep`, to each step's messages.
 *
 * From 7.0.101 the AI SDK converts a tool's output itself; earlier versions keep
 * what `execute` returned. A `Date` from an ORM row then fails the next model
 * call (AI SDK 6), or the next step of the same call (AI SDK 7 before 7.0.101),
 * with a schema error naming only a message index. A value JSON can carry is
 * converted the way the newer SDK does it, including a `BigInt` when the app
 * defines `BigInt.prototype.toJSON`. One it cannot (a `BigInt` otherwise, a
 * circular reference) becomes an error result naming the tool and the field, logged once,
 * so the rest of the history stays valid. On an AI SDK that converts tool outputs
 * itself this does nothing. Returns the same array when nothing changed.
 */
export async function withJsonToolResults(messages: ModelMessage[]): Promise<ModelMessage[]> {
  if (await aiSdkConvertsToolOutputs()) return messages;
  let result: ModelMessage[] | undefined;
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    let content: unknown[] | undefined;
    (message.content as unknown[]).forEach((part, partIndex) => {
      if (!isJsonToolResult(part)) return;
      const outcome = checkedOutput(part.output.value, part);
      if ("value" in outcome && outcome.value === part.output.value) return;
      content ??= [...(message.content as unknown[])];
      content[partIndex] = {
        ...part,
        output:
          "value" in outcome
            ? { ...part.output, value: outcome.value }
            : { type: "error-text", value: unserializableMessage(part.toolName, outcome.problem) },
      };
    });
    if (!content) return;
    result ??= [...messages];
    result[index] = { ...message, content } as ModelMessage;
  });
  return result ?? messages;
}

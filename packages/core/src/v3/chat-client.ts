/**
 * Chat constants shared between backend (ai.ts) and frontend (chat.ts).
 * The ChatClient class lives in @trigger.dev/sdk/chat.
 */

/** The output stream key where UIMessageChunks are written. */
export const CHAT_STREAM_KEY = "chat";

/** Input stream ID for sending chat messages to the running task. */
export const CHAT_MESSAGES_STREAM_ID = "chat-messages";

/** Input stream ID for sending stop signals to abort the current generation. */
export const CHAT_STOP_STREAM_ID = "chat-stop";

// ─── chat.store chunk types ────────────────────────────────────────
//
// First-class chunk types for `chat.store` — bidirectional shared data
// between a chat.agent and its clients. Emitted on the same S2 output
// stream as UIMessageChunks but intercepted by the transport (not
// passed to the AI SDK).

/**
 * An RFC 6902 JSON Patch operation used by `chat.store.patch()` and
 * emitted inside {@link ChatStoreDeltaChunk}.
 *
 * @see https://tools.ietf.org/html/rfc6902
 */
export type ChatStorePatchOperation =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "move"; path: string; from: string }
  | { op: "copy"; path: string; from: string }
  | { op: "test"; path: string; value: unknown };

/** Full-value snapshot — emitted by `chat.store.set(...)`. */
export type ChatStoreSnapshotChunk = {
  type: "store-snapshot";
  value: unknown;
};

/** Incremental update — emitted by `chat.store.patch([...])`. */
export type ChatStoreDeltaChunk = {
  type: "store-delta";
  operations: ChatStorePatchOperation[];
};

export type ChatStoreChunk = ChatStoreSnapshotChunk | ChatStoreDeltaChunk;

// ─── RFC 6902 JSON Patch applier ───────────────────────────────────
//
// Minimal in-process implementation so we don't pull a runtime dep
// into the SDK or webapp. Handles the six RFC 6902 ops with RFC 6901
// JSON Pointer paths. Used by `chat.store.patch()` on the agent and
// the matching client-side `applyStorePatch` on the transport.

function parseJsonPointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer (must start with "/"): ${path}`);
  }
  return path
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through for values that can't be structured-cloned
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function getParentAndKey(
  doc: unknown,
  tokens: string[]
): { parent: any; lastToken: string } {
  if (tokens.length === 0) {
    throw new Error("Cannot get parent of root");
  }
  let parent: any = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (parent == null || typeof parent !== "object") {
      throw new Error(`Path traversal failed at segment "${tokens[i]}"`);
    }
    const key = Array.isArray(parent) ? Number(tokens[i]) : tokens[i];
    parent = (parent as any)[key as any];
  }
  return { parent, lastToken: tokens[tokens.length - 1]! };
}

function readPointer(doc: unknown, tokens: string[]): unknown {
  if (tokens.length === 0) return doc;
  let cursor: any = doc;
  for (const token of tokens) {
    if (cursor == null) return undefined;
    const key = Array.isArray(cursor) ? Number(token) : token;
    cursor = cursor[key];
  }
  return cursor;
}

function removeAt(parent: any, lastToken: string): void {
  if (Array.isArray(parent)) {
    parent.splice(Number(lastToken), 1);
  } else if (parent && typeof parent === "object") {
    delete parent[lastToken];
  } else {
    throw new Error("Cannot remove: parent is not a container");
  }
}

function insertAt(parent: any, lastToken: string, value: unknown, op: "add" | "replace"): void {
  if (Array.isArray(parent)) {
    const idx = lastToken === "-" ? parent.length : Number(lastToken);
    if (op === "add") parent.splice(idx, 0, value);
    else parent[idx] = value;
  } else if (parent && typeof parent === "object") {
    parent[lastToken] = value;
  } else {
    throw new Error("Cannot insert: parent is not a container");
  }
}

/**
 * Apply an RFC 6902 JSON Patch to a document and return the new value.
 * Never mutates the input.
 */
export function applyChatStorePatch(
  doc: unknown,
  operations: readonly ChatStorePatchOperation[]
): unknown {
  let result: any = doc === undefined ? undefined : cloneValue(doc);

  for (const op of operations) {
    const tokens = parseJsonPointer(op.path);

    if (op.op === "test") {
      const actual = readPointer(result, tokens);
      if (JSON.stringify(actual) !== JSON.stringify(op.value)) {
        throw new Error(`JSON Patch test failed at path "${op.path}"`);
      }
      continue;
    }

    if (op.op === "remove") {
      if (tokens.length === 0) {
        result = undefined;
        continue;
      }
      const { parent, lastToken } = getParentAndKey(result, tokens);
      removeAt(parent, lastToken);
      continue;
    }

    // add / replace / move / copy all insert a value at `path`
    let valueToInsert: unknown;
    if (op.op === "add" || op.op === "replace") {
      valueToInsert = cloneValue(op.value);
    } else {
      // move / copy — source must exist
      const fromTokens = parseJsonPointer(op.from);
      valueToInsert = cloneValue(readPointer(result, fromTokens));
      if (op.op === "move" && fromTokens.length > 0) {
        const { parent: fromParent, lastToken: fromLast } = getParentAndKey(result, fromTokens);
        removeAt(fromParent, fromLast);
      }
    }

    if (tokens.length === 0) {
      result = valueToInsert;
      continue;
    }

    const { parent, lastToken } = getParentAndKey(result, tokens);
    insertAt(parent, lastToken, valueToInsert, op.op === "replace" ? "replace" : "add");
  }

  return result;
}

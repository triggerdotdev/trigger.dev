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

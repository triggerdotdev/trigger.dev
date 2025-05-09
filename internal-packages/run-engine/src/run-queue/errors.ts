export class MessageNotFoundError extends Error {
  constructor(messageId: string) {
    super(`Message not found: ${messageId}`);
  }
}

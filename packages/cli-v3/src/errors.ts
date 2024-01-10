export class FatalError extends Error {
  constructor(
    message?: string,
    readonly code?: number
  ) {
    super(message);
  }
}

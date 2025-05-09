export class EngineServiceValidationError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "EngineServiceValidationError";
  }
}

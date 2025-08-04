export class ServiceValidationError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ServiceValidationError";
  }
}

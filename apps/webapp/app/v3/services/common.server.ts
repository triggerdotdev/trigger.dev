export type ServiceValidationErrorLevel = "error" | "warn" | "info";

export class ServiceValidationError extends Error {
  constructor(
    message: string,
    public status?: number,
    public logLevel?: ServiceValidationErrorLevel
  ) {
    super(message);
    this.name = "ServiceValidationError";
  }
}

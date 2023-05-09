import { TaskLogger } from "./types";

type CallbackFunction = (
  level: "DEBUG" | "INFO" | "WARN" | "ERROR",
  message: string,
  properties?: Record<string, any>
) => Promise<void>;

export class ContextLogger implements TaskLogger {
  constructor(private callback: CallbackFunction) {}

  debug(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("DEBUG", message, properties);
  }
  info(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("INFO", message, properties);
  }
  warn(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("WARN", message, properties);
  }
  error(message: string, properties?: Record<string, any>): Promise<void> {
    return this.callback("ERROR", message, properties);
  }
}

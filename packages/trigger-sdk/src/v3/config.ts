import { RetryOptions } from "./retry";

export interface Config {
  project: string;
  triggerDirectories?: string | string[];
  triggerUrl?: string;
  retries?: {
    enabledInDev?: boolean;
    default?: RetryOptions;
  };
}

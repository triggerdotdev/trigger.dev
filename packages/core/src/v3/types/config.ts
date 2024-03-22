import { RetryOptions } from "../schemas";

export interface ProjectConfig {
  project: string;
  triggerDirectories?: string | string[];
  triggerUrl?: string;
  retries?: {
    enabledInDev?: boolean;
    default?: RetryOptions;
  };
  additionalPackages?: string[];
}

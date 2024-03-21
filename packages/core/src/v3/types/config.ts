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
  /**
   * List of patterns that determine if a module is included in your trigger.dev bundle. This is needed when consuming ESM only packages, since the trigger.dev bundle is currently built as a CJS module.
   */
  dependenciesToBundle?: Array<string | RegExp>;
}

import { RetryOptions } from "../schemas";
import type { InstrumentationOption } from "@opentelemetry/instrumentation";

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
   * List of additional files to include in your trigger.dev bundle. e.g. ["./prisma/schema.prisma"]
   *
   * Supports glob patterns.
   */
  additionalFiles?: string[];
  /**
   * List of patterns that determine if a module is included in your trigger.dev bundle. This is needed when consuming ESM only packages, since the trigger.dev bundle is currently built as a CJS module.
   */
  dependenciesToBundle?: Array<string | RegExp>;

  /**
   * The path to your project's tsconfig.json file. Will use tsconfig.json in the project directory if not provided.
   */
  tsconfigPath?: string;

  /**
   * The OpenTelemetry instrumentations to enable
   */
  instrumentations?: InstrumentationOption[];
}

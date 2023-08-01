import { PostHog } from "posthog-node";
import { InitCommandOptions } from "../commands/init.js";
import { nanoid } from "nanoid";
import { getVersion } from "../utils/getVersion.js";

//todo update this to the PROD key: phc_hwYmedO564b3Ik8nhA4Csrb5SueY0EwFJWCbseGwWW
const postHogApiKey = "phc_HBGZden3ls3SinTqYOdZkFct4Rn0aarqUzrodYQ7exE";

export class TelemetryClient {
  #client: PostHog;
  #sessionId: string;
  #version: string;

  constructor() {
    this.#client = new PostHog(postHogApiKey, {
      host: "https://app.posthog.com",
      flushAt: 1,
    });
    this.#sessionId = `cli-${nanoid()}`;
    this.#version = getVersion();
  }

  identify(organizationId: string, projectId: string, userId?: string) {
    if (userId) {
      this.#client.alias({
        distinctId: userId,
        alias: this.#sessionId,
      });
    }

    this.#client.groupIdentify({
      groupType: "organization",
      groupKey: organizationId,
    });

    this.#client.groupIdentify({
      groupType: "project",
      groupKey: projectId,
    });
  }

  init = {
    started: (options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_started",
        properties: this.#initProperties(options),
      });
    },
    isNextJsProject: (
      isNextJsProject: boolean,
      options: InitCommandOptions
    ) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_nextjsproject",
        properties: { ...this.#initProperties(options), isNextJsProject },
      });
    },
    isTypescriptProject: (
      isTypescriptProject: boolean,
      options: InitCommandOptions
    ) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_typescriptproject",
        properties: { ...this.#initProperties(options), isTypescriptProject },
      });
    },
    resolvedApiUrl: (
      apiUrl: string | undefined,
      options: InitCommandOptions
    ) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_resolved_apiurl",
        properties: { ...this.#initProperties(options), apiUrl },
      });
    },
    resolvedApiKey: (options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_resolved_apikey",
        properties: this.#initProperties(options),
      });
    },
    resolvedEndpointSlug: (options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_resolved_endpoint_slug",
        properties: this.#initProperties(options),
      });
    },
    addedDependencies: (options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_added_dependencies",
        properties: this.#initProperties(options),
      });
    },
    setupEnvironmentVariables: (options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_setup_environment_variables",
        properties: this.#initProperties(options),
      });
    },
    createFiles: (options: InitCommandOptions, routerType: "pages" | "app") => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_create_files",
        properties: { ...this.#initProperties(options), routerType },
      });
    },
    detectedMiddleware: (options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_detected_middleware",
        properties: this.#initProperties(options),
      });
    },
    addedConfigurationToPackageJson: (options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_added_configuration_to_package_json",
        properties: this.#initProperties(options),
      });
    },
    completed: (options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_completed",
        properties: this.#initProperties(options),
      });
    },
    failed: (reason: string, options: InitCommandOptions, error?: unknown) => {
      const errorString =
        error instanceof Error ? error.message : String(error);

      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_failed",
        properties: {
          ...this.#initProperties(options),
          reason,
          error: errorString,
        },
      });
    },
  };

  #initProperties(options: InitCommandOptions) {
    return {
      version: this.#version,
      hadApiKey: options.apiKey !== undefined,
      triggerUrl: options.triggerUrl,
      endpointSlug: options.endpointSlug,
      apiUrl: options.apiUrl,
    };
  }
}

import { PostHog } from "posthog-node";
import { InitCommandOptions } from "../commands/init";
import { nanoid } from "nanoid";
import { getVersion } from "../utils/getVersion";
import { DevCommandOptions } from "../commands/dev";
import { ProjectInstallOptions } from "../frameworks";

const postHogApiKey = "phc_9aSDbJCaDUMdZdHxxMPTvcj7A9fsl3mCgM1RBPmPsl7";

export class TelemetryClient {
  #client: PostHog;
  #sessionId: string;
  #version: string;

  constructor() {
    this.#client = new PostHog(postHogApiKey, {
      host: "https://eu.posthog.com",
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
    isTypescriptProject: (isTypescriptProject: boolean, options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_typescriptproject",
        properties: { ...this.#initProperties(options), isTypescriptProject },
      });
    },
    resolvedApiUrl: (apiUrl: string | undefined, options: InitCommandOptions) => {
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
    install: (
      options: InitCommandOptions,
      framework: string,
      installOptions: ProjectInstallOptions
    ) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_install",
        properties: { ...this.#initProperties(options), framework, ...installOptions },
      });
    },
    postInstall: (
      options: InitCommandOptions,
      framework: string,
      installOptions: ProjectInstallOptions
    ) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_post_install",
        properties: { ...this.#initProperties(options), framework, ...installOptions },
      });
    },
    completed: (options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_completed",
        properties: this.#initProperties(options),
      });
    },
    warning: (reason: string, options: InitCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_init_warning",
        properties: {
          ...this.#initProperties(options),
          reason,
        },
      });
    },
    failed: (reason: string, options: InitCommandOptions, error?: unknown) => {
      const errorString = error instanceof Error ? error.message : String(error);

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

  dev = {
    started: (path: string, options: Record<string, string | number | boolean>) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_dev_started",
        properties: { ...options, path },
      });
    },
    serverRunning: (path: string, options: DevCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_dev_server_running",
        properties: { ...options, path },
      });
    },
    tunnelRunning: (path: string, options: DevCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_dev_tunnel_running",
        properties: { ...options, path },
      });
    },
    connected: (path: string, options: DevCommandOptions) => {
      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_dev_connected",
        properties: { ...options, path },
      });
    },
    failed: (
      reason: string,
      options: Record<string, string | number | boolean>,
      error?: unknown
    ) => {
      const errorString = error instanceof Error ? error.message : String(error);

      this.#client.capture({
        distinctId: this.#sessionId,
        event: "cli_dev_failed",
        properties: {
          ...options,
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

export const telemetryClient = new TelemetryClient();

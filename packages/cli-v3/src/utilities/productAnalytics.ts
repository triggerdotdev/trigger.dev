import { PostHog } from "posthog-node";
import { env } from "std-env";
import { POSTHOG_INGEST_HOST, POSTHOG_PROJECT_KEY } from "../consts.js";
import { isTriggerCloudApi } from "./apiUrl.js";
import { getKnownUser, waitForUser, type KnownUser } from "./knownUser.js";

export type AnalyticsGroups = Record<string, string>;

export type AnalyticsEvent = {
  event: string;
  properties: Record<string, unknown>;
  groups?: AnalyticsGroups;
  timestamp?: Date;
};

export type AnalyticsSink = {
  send: (distinctId: string, event: AnalyticsEvent) => void;
  shutdown: (timeoutMs: number) => Promise<void>;
};

export function isAnalyticsEnabled(skipTelemetry: boolean | undefined): boolean {
  if (skipTelemetry) return false;
  return env.TRIGGER_TELEMETRY_DISABLED === undefined;
}

// Names only, never values.
export function argKeys(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  return Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort();
}

const ENVIRONMENT_TYPES: Record<string, string> = {
  dev: "DEVELOPMENT",
  staging: "STAGING",
  prod: "PRODUCTION",
  preview: "PREVIEW",
};

export function environmentTypeOf(input: unknown): string | undefined {
  const environment = (input as { environment?: unknown } | null)?.environment;
  return typeof environment === "string" ? ENVIRONMENT_TYPES[environment] : undefined;
}

function commandRunEvent(input: {
  command: string;
  outcome: "success" | "error" | "started";
  durationMs: number;
  cliVersion: string;
}): AnalyticsEvent {
  return {
    event: "cli_command_run",
    properties: {
      command: input.command,
      outcome: input.outcome,
      durationMs: input.durationMs,
      cliVersion: input.cliVersion,
    },
  };
}

export function mcpInstalledEvent(input: {
  clients: string[];
  scopes: string[];
  outcome: "success" | "error";
  cliVersion: string;
  source: string;
}): AnalyticsEvent {
  return {
    event: "mcp_installed",
    properties: {
      cliVersion: input.cliVersion,
      clients: input.clients,
      scopes: input.scopes,
      outcome: input.outcome,
      source: input.source,
    },
  };
}

export function createPostHogSink(options: {
  flushAt: number;
  flushIntervalMs: number;
}): AnalyticsSink {
  let client: PostHog | undefined;

  return {
    send: (distinctId, { event, properties, groups, timestamp }) => {
      client ??= new PostHog(POSTHOG_PROJECT_KEY, {
        host: POSTHOG_INGEST_HOST,
        flushAt: options.flushAt,
        flushInterval: options.flushIntervalMs,
      });
      client.capture({ distinctId, event, properties, groups, timestamp });
    },
    shutdown: async (timeoutMs) => {
      await client?.shutdown(timeoutMs);
    },
  };
}

function within(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    promise.then(
      () => (clearTimeout(timer), resolve()),
      () => (clearTimeout(timer), resolve())
    );
  });
}

const knownUserNow = async () => getKnownUser();

// capture() never throws and never blocks; an event without a known user is dropped.
export function createAnalytics(options: { enabled: boolean; sink: AnalyticsSink }) {
  const inflight = new Set<Promise<boolean>>();

  return {
    capture(
      event: AnalyticsEvent,
      userId: () => Promise<KnownUser | undefined> = waitForUser,
      groups?: () => Promise<AnalyticsGroups | undefined>,
      // Runs right before the sink call, so state never lags the send; false drops the event.
      beforeSend?: () => boolean
    ) {
      if (!options.enabled) return Promise.resolve(false);

      const timestamp = event.timestamp ?? new Date();
      const task = (async () => {
        const user = await userId();
        if (!user || !isTriggerCloudApi(user.apiUrl)) return false;
        const resolved = await groups?.().catch(() => undefined);
        if (beforeSend && !beforeSend()) return false;
        options.sink.send(user.userId, {
          ...event,
          timestamp,
          ...(resolved ? { groups: resolved } : {}),
        });
        return true;
      })()
        .catch(() => false)
        .finally(() => inflight.delete(task));
      inflight.add(task);
      return task;
    },

    async shutdown(timeoutMs: number) {
      const startedAt = Date.now();
      await within(Promise.all([...inflight]), timeoutMs);
      const left = Math.max(timeoutMs - (Date.now() - startedAt), 0);
      await within(options.sink.shutdown(left), left);
    },
  };
}

export type CommandTracker = { finish: (outcome: "success" | "error") => Promise<void> };

const TRACKED_COMMANDS: Record<string, string> = {
  loginCommand: "login",
  initCommand: "init",
  dev: "dev",
  deployCommand: "deploy",
};

const NOOP_TRACKER: CommandTracker = { finish: async () => {} };

export function trackCommand(
  name: string,
  options: { skipTelemetry?: boolean; cliVersion: string; sink?: AnalyticsSink }
): CommandTracker {
  const command = TRACKED_COMMANDS[name];
  if (!command || !isAnalyticsEnabled(options.skipTelemetry)) return NOOP_TRACKER;

  const startedAt = Date.now();
  const analytics = createAnalytics({
    enabled: true,
    sink: options.sink ?? createPostHogSink({ flushAt: 5, flushIntervalMs: 2000 }),
  });
  const event = (outcome: "success" | "error" | "started") =>
    commandRunEvent({
      command,
      outcome,
      durationMs: Date.now() - startedAt,
      cliVersion: options.cliVersion,
    });

  // dev runs until the process is killed, so it reports once, at start.
  if (command === "dev") {
    analytics.capture(event("started"));
    return NOOP_TRACKER;
  }

  return {
    finish: async (outcome) => {
      if (command === "login" && outcome === "error") return;
      analytics.capture(event(outcome), knownUserNow);
      await analytics.shutdown(1500);
    },
  };
}

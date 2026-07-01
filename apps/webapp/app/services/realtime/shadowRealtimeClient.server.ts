import type { API_VERSIONS } from "~/api/versions";
import { logger } from "../logger.server";
import {
  type RealtimeEnvironment,
  type RealtimeRequestOptions,
  type RealtimeRunsParams,
} from "../realtimeClient.server";
import { RESERVED_COLUMNS } from "./electricStreamProtocol.server";
import {
  type RealtimeListEnvironment,
  type RealtimeStreamClient,
} from "./nativeRealtimeClient.server";
import { type RunListFilter } from "./runReader.server";
import {
  type RealtimeShadowComparator,
  type ShadowCompareOutcome,
  type ShadowFeed,
} from "./shadowCompare.server";

export type ShadowRealtimeClientOptions = {
  /** The path actually served to the client (Electric). */
  electric: RealtimeStreamClient;
  comparator: RealtimeShadowComparator;
  /** createdAt window (ms) used to resolve tag-list membership for the compare. */
  maximumCreatedAtFilterAgeMs: number;
  /** Cap for the membership resolve. */
  maxListResults: number;
  /** Metrics sink for compare outcomes. */
  onOutcome?: (outcome: ShadowCompareOutcome) => void;
};

/** Transparent wrapper that serves the Electric response unchanged and, in the background (fire-and-forget), diffs what the native backend would emit. */
export class ShadowRealtimeClient implements RealtimeStreamClient {
  constructor(private readonly options: ShadowRealtimeClientOptions) {}

  async streamRun(
    url: URL | string,
    environment: RealtimeEnvironment,
    runId: string,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const response = await this.options.electric.streamRun(
      url,
      environment,
      runId,
      apiVersion,
      requestOptions,
      clientVersion,
      signal
    );
    this.#shadow("run", response, url, environment, requestOptions);
    return response;
  }

  async streamRuns(
    url: URL | string,
    environment: RealtimeListEnvironment,
    params: RealtimeRunsParams,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const response = await this.options.electric.streamRuns(
      url,
      environment,
      params,
      apiVersion,
      requestOptions,
      clientVersion,
      signal
    );
    this.#shadow("runs", response, url, environment, requestOptions, { tags: params.tags ?? [] });
    return response;
  }

  async streamBatch(
    url: URL | string,
    environment: RealtimeListEnvironment,
    batchId: string,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const response = await this.options.electric.streamBatch(
      url,
      environment,
      batchId,
      apiVersion,
      requestOptions,
      clientVersion,
      signal
    );
    this.#shadow("batch", response, url, environment, requestOptions, { batchId });
    return response;
  }

  /** Fire-and-forget; never blocks the served response, never throws into the request. */
  #shadow(
    feed: ShadowFeed,
    electricResponse: Response,
    url: URL | string,
    environment: RealtimeEnvironment & { projectId?: string },
    requestOptions?: RealtimeRequestOptions,
    membership?: { tags?: string[]; batchId?: string }
  ): void {
    // Clone synchronously before the client consumes the body.
    let bodyClone: Response;
    try {
      if (electricResponse.status !== 200) {
        return;
      }
      bodyClone = electricResponse.clone();
    } catch {
      return;
    }

    void this.#runShadow(feed, bodyClone, url, environment, requestOptions, membership).catch(
      (error) => logger.debug("[shadowRealtime] compare failed", { feed, error })
    );
  }

  async #runShadow(
    feed: ShadowFeed,
    bodyClone: Response,
    url: URL | string,
    environment: RealtimeEnvironment & { projectId?: string },
    requestOptions: RealtimeRequestOptions | undefined,
    membership: { tags?: string[]; batchId?: string } | undefined
  ): Promise<void> {
    const $url = new URL(url.toString());
    const offset = $url.searchParams.get("offset") ?? "-1";
    const handle = $url.searchParams.get("handle") ?? $url.searchParams.get("shape_id");
    const isInitialSnapshot = offset === "-1" || !handle;
    const skipColumns = resolveSkipColumns($url, requestOptions);
    const electricBody = await bodyClone.text();

    let membershipFilter: RunListFilter | undefined;
    if (isInitialSnapshot && membership && environment.projectId) {
      membershipFilter = {
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        tags: membership.tags,
        batchId: membership.batchId,
        createdAtAfter: membership.batchId
          ? undefined
          : new Date(Date.now() - this.options.maximumCreatedAtFilterAgeMs),
        limit: this.options.maxListResults,
      };
    }

    const outcome = await this.options.comparator.compare({
      feed,
      electricBody,
      environment: { id: environment.id },
      skipColumns,
      isInitialSnapshot,
      membershipFilter,
    });

    this.options.onOutcome?.(outcome);

    if (outcome.serializationDiverged > 0 || outcome.membershipMatch === false) {
      logger.warn("[shadowRealtime] divergence detected", {
        feed,
        serializationDiverged: outcome.serializationDiverged,
        serializationMatched: outcome.serializationMatched,
        serializationSkew: outcome.serializationSkew,
        membershipMatch: outcome.membershipMatch,
        missingInNative: outcome.missingInNative?.slice(0, 20),
        extraInNative: outcome.extraInNative?.slice(0, 20),
        // Log only which run/column diverged, never the raw cell values — they can
        // include run payload/output/metadata and must not leak into logs.
        diffs: outcome.diffs.map(({ runId, column }) => ({ runId, column })),
      });
    }
  }
}

function resolveSkipColumns(url: URL, requestOptions?: RealtimeRequestOptions): string[] {
  const raw = requestOptions?.skipColumns ?? url.searchParams.get("skipColumns")?.split(",") ?? [];
  return raw.map((c) => c.trim()).filter((c) => c !== "" && !RESERVED_COLUMNS.includes(c));
}

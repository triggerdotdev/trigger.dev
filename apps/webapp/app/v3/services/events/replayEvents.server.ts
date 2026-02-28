import type { EventFilter } from "@trigger.dev/core/v3";
import { eventFilterMatches } from "@trigger.dev/core/v3";
import type { ClickHouse } from "@internal/clickhouse";
import { PrismaClientOrTransaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { BaseService, ServiceValidationError } from "../baseService.server";
import { PublishEventService, type TriggerFn, type EventLogWriter } from "./publishEvent.server";

const MAX_REPLAY_EVENTS = 10_000;

export type ReplayEventsParams = {
  eventSlug: string;
  environment: AuthenticatedEnvironment;
  from: Date;
  to: Date;
  filter?: EventFilter;
  tasks?: string[];
  dryRun?: boolean;
};

export type ReplayResult = {
  replayedCount: number;
  skippedCount: number;
  dryRun: boolean;
  runs?: Array<{
    taskIdentifier: string;
    runId: string;
    sourceEventId: string;
  }>;
};

export class ReplayEventsService extends BaseService {
  private readonly _clickhouse: ClickHouse;
  private readonly _triggerFn?: TriggerFn;
  private readonly _eventLogWriter?: EventLogWriter;

  constructor(
    clickhouse: ClickHouse,
    prisma?: PrismaClientOrTransaction,
    triggerFn?: TriggerFn,
    eventLogWriter?: EventLogWriter
  ) {
    super(prisma);
    this._clickhouse = clickhouse;
    this._triggerFn = triggerFn;
    this._eventLogWriter = eventLogWriter;
  }

  public async call(params: ReplayEventsParams): Promise<ReplayResult> {
    return this.traceWithEnv("replayEvents", params.environment, async (span) => {
      span.setAttribute("eventSlug", params.eventSlug);
      span.setAttribute("dryRun", params.dryRun ?? false);

      // 1. Query ClickHouse for events in the date range
      const queryBuilder = this._clickhouse.eventLog.queryBuilder();

      queryBuilder
        .where("project_id = {projectId: String}", {
          projectId: params.environment.projectId,
        })
        .where("environment_id = {environmentId: String}", {
          environmentId: params.environment.id,
        })
        .where("event_type = {eventType: String}", {
          eventType: params.eventSlug,
        })
        .where("published_at >= {from: DateTime64(3)}", {
          from: params.from.toISOString(),
        })
        .where("published_at <= {to: DateTime64(3)}", {
          to: params.to.toISOString(),
        })
        .orderBy("published_at ASC, event_id ASC")
        .limit(MAX_REPLAY_EVENTS);

      const [queryError, events] = await queryBuilder.execute();

      if (queryError) {
        logger.error("Failed to query events for replay", {
          eventSlug: params.eventSlug,
          error: queryError.message,
        });
        throw new ServiceValidationError("Failed to query events for replay", 500);
      }

      span.setAttribute("totalEventsInRange", events.length);

      if (events.length === 0) {
        return { replayedCount: 0, skippedCount: 0, dryRun: params.dryRun ?? false };
      }

      // 2. Apply optional filter to narrow down events
      let filteredEvents = events;
      if (params.filter) {
        filteredEvents = events.filter((event) => {
          try {
            const payload = JSON.parse(event.payload);
            return eventFilterMatches(payload, params.filter!);
          } catch {
            return false;
          }
        });
      }

      span.setAttribute("filteredEventsCount", filteredEvents.length);

      const skippedCount = events.length - filteredEvents.length;

      if (params.dryRun) {
        return {
          replayedCount: filteredEvents.length,
          skippedCount,
          dryRun: true,
        };
      }

      // 3. Re-publish each event with replay idempotency keys
      const publishService = new PublishEventService(
        this._prisma,
        this._triggerFn,
        this._eventLogWriter
      );

      const runs: NonNullable<ReplayResult["runs"]> = [];
      let replayedCount = 0;

      for (const event of filteredEvents) {
        try {
          const payload = JSON.parse(event.payload);
          const replayIdempotencyKey = `replay:${event.event_id}`;

          const result = await publishService.call(
            params.eventSlug,
            params.environment,
            payload,
            {
              idempotencyKey: replayIdempotencyKey,
              tags: event.tags.length > 0 ? event.tags : undefined,
            }
          );

          // Filter to only the requested tasks (if specified)
          const matchingRuns = params.tasks
            ? result.runs.filter((r) => params.tasks!.includes(r.taskIdentifier))
            : result.runs;

          for (const run of matchingRuns) {
            runs.push({
              taskIdentifier: run.taskIdentifier,
              runId: run.runId,
              sourceEventId: event.event_id,
            });
          }

          replayedCount++;
        } catch (error) {
          logger.warn("Failed to replay event", {
            eventId: event.event_id,
            eventSlug: params.eventSlug,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      span.setAttribute("replayedCount", replayedCount);
      span.setAttribute("totalRunsCreated", runs.length);

      return {
        replayedCount,
        skippedCount,
        dryRun: false,
        runs,
      };
    });
  }
}

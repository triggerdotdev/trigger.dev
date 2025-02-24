import { Attributes } from "@opentelemetry/api";
import { TriggerTracerSpanEvent } from "../tracer.js";
import { getGlobal, registerGlobal } from "../utils/globals.js";
import { NoopRunTimelineMetricsManager } from "./runTimelineMetricsManager.js";
import { RunTimelineMetric, RunTimelineMetricsManager } from "./types.js";
import { flattenAttributes } from "../utils/flattenAttributes.js";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";

const API_NAME = "run-timeline-metrics";

const NOOP_MANAGER = new NoopRunTimelineMetricsManager();

export class RunTimelineMetricsAPI implements RunTimelineMetricsManager {
  private static _instance?: RunTimelineMetricsAPI;

  private constructor() {}

  public static getInstance(): RunTimelineMetricsAPI {
    if (!this._instance) {
      this._instance = new RunTimelineMetricsAPI();
    }

    return this._instance;
  }

  registerMetric(metric: RunTimelineMetric): void {
    this.#getManager().registerMetric(metric);
  }

  getMetrics(): RunTimelineMetric[] {
    return this.#getManager().getMetrics();
  }

  /**
   * Measures the execution time of an async function and registers it as a metric
   * @param metricName The name of the metric
   * @param eventName The event name
   * @param attributesOrCallback Optional attributes or the callback function
   * @param callbackFn The async function to measure (if attributes were provided)
   * @returns The result of the callback function
   */
  async measureMetric<T>(
    metricName: string,
    eventName: string,
    attributesOrCallback: Attributes | (() => Promise<T>),
    callbackFn?: () => Promise<T>
  ): Promise<T> {
    // Handle overloaded function signature
    let attributes: Attributes = {};
    let callback: () => Promise<T>;

    if (typeof attributesOrCallback === "function") {
      callback = attributesOrCallback;
    } else {
      attributes = attributesOrCallback || {};
      if (!callbackFn) {
        throw new Error("Callback function is required when attributes are provided");
      }
      callback = callbackFn;
    }

    // Record start time
    const startTime = Date.now();

    try {
      // Execute the callback
      const result = await callback();

      // Calculate duration
      const duration = Date.now() - startTime;

      // Register the metric
      this.registerMetric({
        name: metricName,
        event: eventName,
        attributes: {
          ...attributes,
          duration,
        },
        timestamp: startTime,
      });

      return result;
    } catch (error) {
      // Register the metric even if there's an error, but mark it as failed
      const duration = Date.now() - startTime;

      this.registerMetric({
        name: metricName,
        event: eventName,
        attributes: {
          ...attributes,
          duration,
          error: error instanceof Error ? error.message : String(error),
          status: "failed",
        },
        timestamp: startTime,
      });

      // Re-throw the error
      throw error;
    }
  }

  convertMetricsToSpanEvents(): TriggerTracerSpanEvent[] {
    const metrics = this.getMetrics();

    const spanEvents: TriggerTracerSpanEvent[] = metrics.map((metric) => {
      return {
        name: metric.name,
        startTime: metric.timestamp,
        attributes: {
          ...metric.attributes,
          event: metric.event,
        },
      };
    });

    return spanEvents;
  }

  convertMetricsToSpanAttributes(): Attributes {
    const metrics = this.getMetrics();

    if (metrics.length === 0) {
      return {};
    }

    // Group metrics by name
    const metricsByName = metrics.reduce(
      (acc, metric) => {
        if (!acc[metric.name]) {
          acc[metric.name] = [];
        }
        acc[metric.name]!.push(metric);
        return acc;
      },
      {} as Record<string, typeof metrics>
    );

    // Process each metric type
    const reducedMetrics = metrics.reduce(
      (acc, metric) => {
        acc[metric.event] = {
          name: metric.name,
          timestamp: metric.timestamp,
          event: metric.event,
          ...flattenAttributes(metric.attributes, "attributes"),
        };
        return acc;
      },
      {} as Record<string, Attributes>
    );

    const metricEventRollups: Record<
      string,
      { timestamp: number; duration: number; name: string }
    > = {};

    // Calculate duration for each metric type
    // Calculate duration for each metric type
    for (const [metricName, metricEvents] of Object.entries(metricsByName)) {
      // Skip if there are no events for this metric
      if (metricEvents.length === 0) continue;

      // Sort events by timestamp
      const sortedEvents = [...metricEvents].sort((a, b) => a.timestamp - b.timestamp);

      // Get first event timestamp (we know it exists because we checked length above)
      const firstTimestamp = sortedEvents[0]!.timestamp;

      // Get last event (we know it exists because we checked length above)
      const lastEvent = sortedEvents[sortedEvents.length - 1]!;

      // Calculate total duration: from first event to (last event + its duration)
      // Use optional chaining and nullish coalescing for safety
      const lastEventDuration = (lastEvent.attributes?.duration as number) ?? 0;
      const lastEventEndTime = lastEvent.timestamp + lastEventDuration;

      // Store the total duration for this metric type
      const duration = lastEventEndTime - firstTimestamp;
      const timestamp = firstTimestamp;
      metricEventRollups[metricName] = {
        name: metricName,
        duration,
        timestamp,
      };
    }

    return {
      ...flattenAttributes(reducedMetrics, SemanticInternalAttributes.METRIC_EVENTS),
      ...flattenAttributes(metricEventRollups, SemanticInternalAttributes.METRIC_EVENTS),
    };
  }

  setGlobalManager(manager: RunTimelineMetricsManager): boolean {
    return registerGlobal(API_NAME, manager);
  }

  #getManager(): RunTimelineMetricsManager {
    return getGlobal(API_NAME) ?? NOOP_MANAGER;
  }
}

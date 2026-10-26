import type { SerializeFrom } from "@remix-run/server-runtime";
import type { TraceViewEvent } from "~/v3/eventRepository/traceViewBuilder";

/** A trace tree event as the run page loader serializes it. */
export type TraceEvent = SerializeFrom<TraceViewEvent>;

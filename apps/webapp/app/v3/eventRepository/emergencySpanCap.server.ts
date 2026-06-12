import { env } from "~/env.server";

// Emergency circuit breaker for trace views: when TRACE_VIEW_EMERGENCY_SPAN_CAP
// is set, clamp a trace summary span limit to it. Unset = no clamping.
export function clampToEmergencySpanCap(limit: number): number {
  const cap = env.TRACE_VIEW_EMERGENCY_SPAN_CAP;
  return cap === undefined ? limit : Math.min(limit, cap);
}

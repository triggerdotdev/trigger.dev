/**
 * The bounds on a `submit_feedback` report. Shared so the tool's schema and the route that
 * records it can't drift apart and turn a valid report into a 400.
 */
export const DASHBOARD_AGENT_FEEDBACK_LIMITS = {
  message: 4000,
  toolName: 100,
} as const;

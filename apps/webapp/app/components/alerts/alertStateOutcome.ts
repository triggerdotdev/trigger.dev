import { formatDistance } from "date-fns";

/**
 * Labels for a state-kind alert's current reading (report bindings: health.*).
 * `unavailable` (e.g. the report couldn't load) is distinct from a genuinely
 * healthy `not_met` -- both used to render as "Healthy", which hid an outage.
 */
export function stateOutcomeLabel(outcome: string): string {
  switch (outcome) {
    case "met":
      return "Degraded";
    case "unavailable":
      return "Unavailable";
    default:
      return "Healthy";
  }
}

export type AlertEpisode = {
  raisedAt: Date | null;
  recoveredAt: Date | null;
  outcome: "raised" | "recovered" | null;
};

export type AlertEpisodeState = {
  attention: "clear" | "needs_attention";
  observedCondition: "unknown" | "met" | "not_met";
};

export function alertEpisode(
  events: ReadonlyArray<{ type: string; at: Date }>,
  state?: AlertEpisodeState
): AlertEpisode {
  let raisedAt: Date | null = null;
  let lastRecoveredAt: Date | null = null;
  for (const event of events) {
    if (event.type === "raised" && (!raisedAt || event.at > raisedAt)) raisedAt = event.at;
    if (event.type === "recovered" && (!lastRecoveredAt || event.at > lastRecoveredAt)) {
      lastRecoveredAt = event.at;
    }
  }
  const recoveredAt =
    lastRecoveredAt &&
    (!raisedAt || lastRecoveredAt > raisedAt) &&
    state?.observedCondition !== "met"
      ? lastRecoveredAt
      : null;
  const raiseCurrent =
    !state || state.attention === "needs_attention" || state.observedCondition === "met";
  return {
    raisedAt,
    recoveredAt,
    outcome: recoveredAt ? "recovered" : raisedAt && raiseCurrent ? "raised" : null,
  };
}

export function episodeFromTimes(
  times: { raisedAt: Date | null; recoveredAt: Date | null },
  state?: AlertEpisodeState
): AlertEpisode {
  return alertEpisode(
    [
      ...(times.raisedAt ? [{ type: "raised", at: times.raisedAt }] : []),
      ...(times.recoveredAt ? [{ type: "recovered", at: times.recoveredAt }] : []),
    ],
    state
  );
}

export function episodeStateOutcome(episode: AlertEpisode): "met" | "not_met" | null {
  if (episode.outcome === "raised") return "met";
  if (episode.outcome === "recovered") return "not_met";
  return null;
}

export function episodeLine(
  episode: AlertEpisode,
  countSinceRaise?: number,
  now: Date = new Date()
): string | null {
  if (episode.outcome === "recovered") return "recovered · safe to resolve";
  if (!episode.raisedAt) return null;
  const raised = `raised ${formatDistance(episode.raisedAt, now, { addSuffix: true })}`;
  return countSinceRaise !== undefined ? `${raised} · ${countSinceRaise} since` : raised;
}

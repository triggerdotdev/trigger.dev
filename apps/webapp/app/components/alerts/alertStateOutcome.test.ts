import { describe, expect, it } from "vitest";
import {
  alertEpisode,
  episodeLine,
  episodeStateOutcome,
  stateOutcomeLabel,
} from "./alertStateOutcome";

describe("stateOutcomeLabel", () => {
  it("labels a met outcome as Degraded", () => {
    expect(stateOutcomeLabel("met")).toBe("Degraded");
  });

  it("labels an unavailable outcome as Unavailable, not Healthy", () => {
    expect(stateOutcomeLabel("unavailable")).toBe("Unavailable");
  });

  it("labels not_met as Healthy", () => {
    expect(stateOutcomeLabel("not_met")).toBe("Healthy");
  });
});

describe("alertEpisode", () => {
  const now = new Date("2026-01-10T00:00:00Z");
  const raised = { type: "raised", at: new Date("2026-01-09T00:00:00Z") };
  const recovered = { type: "recovered", at: new Date("2026-01-09T06:00:00Z") };

  it("raise then recover is recovered, with header and state agreeing", () => {
    const episode = alertEpisode([recovered, raised]);
    expect(episode.outcome).toBe("recovered");
    expect(episode.recoveredAt).toEqual(recovered.at);
    expect(episodeLine(episode, undefined, now)).toBe("recovered · safe to resolve");
    expect(stateOutcomeLabel(episodeStateOutcome(episode)!)).toBe("Healthy");
  });

  it("a raise after a recovery is raised and drops the stale recovery", () => {
    const newerRaise = { type: "raised", at: new Date("2026-01-09T12:00:00Z") };
    const episode = alertEpisode([newerRaise, recovered, raised]);
    expect(episode.outcome).toBe("raised");
    expect(episode.raisedAt).toEqual(newerRaise.at);
    expect(episode.recoveredAt).toBeNull();
    expect(episodeLine(episode, undefined, now)).toBe("raised about 12 hours ago");
    expect(stateOutcomeLabel(episodeStateOutcome(episode)!)).toBe("Degraded");
  });

  it("does not depend on event order", () => {
    expect(alertEpisode([raised, recovered])).toEqual(alertEpisode([recovered, raised]));
  });

  it("has no outcome without events", () => {
    const episode = alertEpisode([]);
    expect(episode.outcome).toBeNull();
    expect(episodeLine(episode, undefined, now)).toBeNull();
    expect(episodeStateOutcome(episode)).toBeNull();
  });
});

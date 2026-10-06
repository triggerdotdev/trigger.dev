import { serialiseSnapshot, deserialiseSnapshot } from "@trigger.dev/redis-worker";

// MollifierSnapshot is the JSON-serialisable shape of the input that would be
// passed to engine.trigger(). The drainer deserialises and replays it.
// Kept as Record<string, unknown> at this layer — the engine.trigger call site
// casts it to the engine's typed input. This keeps the mollifier subdirectory
// from depending on @internal/run-engine internals.
export type MollifierSnapshot = Record<string, unknown>;

export function serialiseMollifierSnapshot(input: MollifierSnapshot): string {
  return serialiseSnapshot(input);
}

export function deserialiseMollifierSnapshot(serialised: string): MollifierSnapshot {
  return deserialiseSnapshot<MollifierSnapshot>(serialised);
}

/** Buffered environments carry historical flags, not a current birth-time decision. */
export function prepareMollifierReplay(snapshot: MollifierSnapshot): MollifierSnapshot {
  const environment = snapshot.environment;
  if (!environment || typeof environment !== "object" || !("organization" in environment)) {
    return snapshot;
  }
  const organization = environment.organization;
  if (!organization || typeof organization !== "object") return snapshot;
  return {
    ...snapshot,
    environment: {
      ...environment,
      // undefined means not loaded, so the existing snapshot resolver fetches the current flags.
      organization: { ...organization, featureFlags: undefined },
    },
  };
}

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

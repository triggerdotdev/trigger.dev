import { monotonicFactory } from "ulid";

const factory = monotonicFactory();

export function ulid(): ReturnType<typeof factory> {
  return factory().toLowerCase();
}

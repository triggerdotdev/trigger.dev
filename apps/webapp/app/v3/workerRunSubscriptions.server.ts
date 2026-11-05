import { z } from "zod";

const RunSubscriptionSchema = z.object({
  version: z.literal("1"),
  runFriendlyIds: z.array(z.string().min(1)),
});

// Keep each ownership lookup well below PostgreSQL's bind-parameter limit.
const RUN_SUBSCRIPTION_QUERY_BATCH_SIZE = 512;

type AuthorizeRuns = (runFriendlyIds: string[]) => Promise<string[]>;

export class WorkerRunSubscriptions {
  private readonly pending = new Map<string, symbol>();

  constructor(private readonly authorize: AuthorizeRuns) {}

  async subscribe(payload: unknown, join: (runFriendlyId: string) => void): Promise<string[]> {
    const { runFriendlyIds } = RunSubscriptionSchema.parse(payload);
    const ids = [...new Set(runFriendlyIds)];
    const request = Symbol("run subscription");
    for (const id of ids) this.pending.set(id, request);

    try {
      const allowed: string[] = [];
      for (let offset = 0; offset < ids.length; offset += RUN_SUBSCRIPTION_QUERY_BATCH_SIZE) {
        const batch = ids.slice(offset, offset + RUN_SUBSCRIPTION_QUERY_BATCH_SIZE);
        allowed.push(...(await this.authorize(batch)));
      }

      const subscribed = allowed.filter((id) => this.pending.get(id) === request);
      // Join before yielding again so an unsubscribe cannot overtake this check.
      for (const id of subscribed) join(id);
      return subscribed;
    } finally {
      for (const id of ids) {
        if (this.pending.get(id) === request) this.pending.delete(id);
      }
    }
  }

  unsubscribe(payload: unknown): string[] {
    const { runFriendlyIds } = RunSubscriptionSchema.parse(payload);
    const ids = [...new Set(runFriendlyIds)];
    for (const id of ids) this.pending.delete(id);
    return ids;
  }

  clear() {
    this.pending.clear();
  }
}

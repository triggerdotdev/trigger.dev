import { describe, expect, it } from "vitest";
import { WorkerRunSubscriptions } from "~/v3/workerRunSubscriptions.server";

const payload = (runFriendlyIds: string[]) => ({ version: "1", runFriendlyIds });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("worker run subscriptions", () => {
  // Catches: an in-flight ownership lookup restoring a cancelled subscription.
  it("honors unsubscribe while authorization is pending", async () => {
    const lookup = deferred<string[]>();
    const subscriptions = new WorkerRunSubscriptions(() => lookup.promise);
    const joined = new Set<string>();
    const pending = subscriptions.subscribe(payload(["run_one", "run_two"]), (id) =>
      joined.add(id)
    );

    for (const id of subscriptions.unsubscribe(payload(["run_one"]))) joined.delete(id);
    lookup.resolve(["run_one", "run_two"]);
    await pending;

    expect([...joined]).toEqual(["run_two"]);
  });

  // Catches: an earlier lookup overriding a newer subscription decision or joining after disconnect.
  it("preserves a later resubscription and cancels pending joins on disconnect", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const third = deferred<string[]>();
    const lookups = [first.promise, second.promise, third.promise];
    const subscriptions = new WorkerRunSubscriptions(() => lookups.shift()!);
    const joined: string[] = [];
    const older = subscriptions.subscribe(payload(["run_one"]), (id) => joined.push(id));
    subscriptions.unsubscribe(payload(["run_one"]));
    const newer = subscriptions.subscribe(payload(["run_one"]), (id) => joined.push(id));

    first.resolve(["run_one"]);
    await older;
    expect(joined).toEqual([]);
    second.resolve(["run_one"]);
    await newer;
    expect(joined).toEqual(["run_one"]);

    const disconnected = subscriptions.subscribe(payload(["run_two"]), (id) => joined.push(id));
    subscriptions.clear();
    third.resolve(["run_two"]);
    await disconnected;
    expect(joined).toEqual(["run_one"]);
  });

  // Catches: oversized database queries or dropping valid subscriptions when splitting a large request.
  it("deduplicates and authorizes a large subscription in bounded batches", async () => {
    const ids = Array.from({ length: 1500 }, (_, index) => `run_${index}`);
    const foreign = ids[750];
    const queried: string[] = [];
    const subscriptions = new WorkerRunSubscriptions(async (batch) => {
      expect(batch.length).toBeLessThanOrEqual(512);
      queried.push(...batch);
      return batch.filter((id) => id !== foreign);
    });
    const joined: string[] = [];
    await subscriptions.subscribe(payload([...ids, ...ids]), (id) => joined.push(id));

    expect(queried).toEqual(ids);
    expect(joined).toEqual(ids.filter((id) => id !== foreign));
  });

  // Catches: malformed events reaching authorization, or partial joins after a failed lookup.
  it("rejects malformed payloads and fails closed when authorization fails", async () => {
    let lookups = 0;
    const subscriptions = new WorkerRunSubscriptions(async (batch) => {
      lookups++;
      if (lookups === 2) throw new Error("lookup failed");
      return batch;
    });
    const joined: string[] = [];
    for (const invalid of [null, {}, { version: "1", runFriendlyIds: [1] }]) {
      await expect(subscriptions.subscribe(invalid, (id) => joined.push(id))).rejects.toThrow();
      expect(() => subscriptions.unsubscribe(invalid)).toThrow();
    }
    expect(lookups).toBe(0);

    const ids = Array.from({ length: 600 }, (_, index) => `run_${index}`);
    await expect(subscriptions.subscribe(payload(ids), (id) => joined.push(id))).rejects.toThrow(
      "lookup failed"
    );
    expect(joined).toEqual([]);
  });
});

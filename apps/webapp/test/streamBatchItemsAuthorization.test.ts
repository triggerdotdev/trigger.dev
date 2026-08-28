import { buildJwtAbility } from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import { withActionAliases } from "@trigger.dev/rbac";
import {
  authorizeBatchItems,
  authorizedBatchItemStream,
  batchPublicAccessScopes,
} from "~/utils/batchItemAuthorization";
import { canWriteResolvedParentRun } from "~/utils/parentRunAuthorization";

async function collect(items: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const item of items) result.push(item);
  return result;
}

async function* batchItems(...tasks: string[]): AsyncIterable<unknown> {
  for (const task of tasks) yield { task, payload: {} };
}

describe("streaming batch item authorization", () => {
  it("rejects a selected-task key when any streamed task is unauthorized", async () => {
    const ability = withActionAliases(buildJwtAbility(["batchTrigger:tasks:task-a"]));

    await expect(
      collect(authorizeBatchItems(batchItems("task-a", "task-b"), ability, "batch_123"))
    ).rejects.toThrow();
  });

  it("allows all items covered by the key's task grants", async () => {
    const ability = withActionAliases(
      buildJwtAbility(["batchTrigger:tasks:task-a", "batchTrigger:tasks:task-b"])
    );

    await expect(
      collect(authorizeBatchItems(batchItems("task-a", "task-b"), ability, "batch_123"))
    ).resolves.toHaveLength(2);
  });

  it("preserves a public JWT's write grant for the batch", async () => {
    const ability = withActionAliases(buildJwtAbility(["write:batch:batch_123"]));

    await expect(
      collect(authorizeBatchItems(batchItems("task-a", "task-b"), ability, "batch_123"))
    ).resolves.toHaveLength(2);
  });

  it("does not delegate batch-wide writes from selected-task credentials", () => {
    const ability = withActionAliases(buildJwtAbility(["batchTrigger:tasks:task-a"]));

    expect(batchPublicAccessScopes("batch_123", ability, true)).toEqual(["read:batch:batch_123"]);
  });

  it("delegates batch-wide writes when the credential can trigger every task", () => {
    const ability = withActionAliases(buildJwtAbility(["batchTrigger:tasks"]));

    expect(batchPublicAccessScopes("batch_123", ability, true)).toEqual([
      "read:batch:batch_123",
      "write:batch:batch_123",
    ]);
  });

  it("rejects an empty stream from a credential with no batch-level write grant", async () => {
    const ability = withActionAliases(buildJwtAbility(["batchTrigger:tasks:task-a"]));

    // An empty stream authorizes nothing, so it must not reach the service —
    // whose batch lookup would otherwise report the batch's existence and status.
    await expect(authorizedBatchItemStream(batchItems(), ability, "batch_123")).rejects.toThrow();
  });

  it("allows an empty stream from a credential that can write the batch", async () => {
    const ability = withActionAliases(buildJwtAbility(["write:batch:batch_123"]));

    const stream = await authorizedBatchItemStream(batchItems(), ability, "batch_123");

    await expect(collect(stream)).resolves.toHaveLength(0);
  });

  it("still authorizes every item when the first one passes", async () => {
    const ability = withActionAliases(buildJwtAbility(["batchTrigger:tasks:task-a"]));

    const stream = await authorizedBatchItemStream(
      batchItems("task-a", "task-b"),
      ability,
      "batch_123"
    );

    await expect(collect(stream)).rejects.toThrow();
  });

  it("replays the eagerly-pulled first item to the consumer", async () => {
    const ability = withActionAliases(buildJwtAbility(["batchTrigger:tasks:task-a"]));

    const stream = await authorizedBatchItemStream(
      batchItems("task-a", "task-a"),
      ability,
      "batch_123"
    );

    await expect(collect(stream)).resolves.toEqual([
      { task: "task-a", payload: {} },
      { task: "task-a", payload: {} },
    ]);
  });

  it("treats a type-level write:runs grant as covering every parent run", () => {
    // The route-level `canWriteParentRun` short-circuits on this, skipping a DB
    // lookup per distinct parent. Assert the premise holds: the grant really
    // does authorize an arbitrary run id.
    const ability = withActionAliases(buildJwtAbility(["write:runs"]));

    expect(
      canWriteResolvedParentRun(ability, {
        friendlyId: "run_anything",
        taskIdentifier: "some-task-we-have-no-grant-for",
      })
    ).toBe(true);
  });

  it("only allows selected-task operators to link parent runs for their tasks", () => {
    const ability = withActionAliases(buildJwtAbility(["write:tasks:task-a"]));

    expect(
      canWriteResolvedParentRun(ability, {
        friendlyId: "run_a",
        taskIdentifier: "task-a",
      })
    ).toBe(true);
    expect(
      canWriteResolvedParentRun(ability, {
        friendlyId: "run_b",
        taskIdentifier: "task-b",
      })
    ).toBe(false);
  });
});

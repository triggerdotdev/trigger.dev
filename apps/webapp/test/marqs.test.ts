import { SimpleWeightedChoiceStrategy } from "../app/v3/marqs/priorityStrategy.server";

describe("SimpleWeightedChoiceStrategy", () => {
  it("should use a weighted random choice algorithm to choose a queue", async () => {
    const stategy = new SimpleWeightedChoiceStrategy({
      queueSelectionCount: 3,
      randomSeed: "test",
    });

    const chosenQueue = stategy.chooseQueue(
      [
        {
          queue: "queue1",
          age: 4497,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
        {
          queue: "queue2",
          age: 19670,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
        {
          queue: "queue3",
          age: 12828,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
      ],
      "parentQueue",
      "selectionId"
    );

    expect(chosenQueue).toEqual("queue3");
  });

  it("should filter out queues if any capacity is full", async () => {
    const stategy = new SimpleWeightedChoiceStrategy({
      queueSelectionCount: 3,
      randomSeed: "test",
    });

    const chosenQueue = stategy.chooseQueue(
      [
        {
          queue: "queue1",
          age: 4497,
          capacities: {
            queue: { current: 10, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
        {
          queue: "queue2",
          age: 19670,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 10, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
        {
          queue: "queue3",
          age: 12828,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 10, limit: 10 },
          },
        },
      ],
      "parentQueue",
      "selectionId"
    );

    expect(chosenQueue).toEqual({ abort: true });

    const nextSelection = await stategy.nextCandidateSelection("parentQueue");

    expect(nextSelection).toEqual({ range: [3, 6], selectionId: expect.any(String) });

    // Now pass some queues that have some capacity
    const chosenQueue2 = stategy.chooseQueue(
      [
        {
          queue: "queue1",
          age: 4497,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
        {
          queue: "queue2",
          age: 19670,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
        {
          queue: "queue3",
          age: 12828,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
      ],
      "parentQueue",
      "selectionId"
    );

    expect(chosenQueue2).toEqual("queue3");

    const nextSelection2 = await stategy.nextCandidateSelection("parentQueue");

    expect(nextSelection2).toEqual({ range: [0, 3], selectionId: expect.any(String) });
  });

  it("should adjust the next filter range only if passed the maximum number of queues", async () => {
    const stategy = new SimpleWeightedChoiceStrategy({
      queueSelectionCount: 3,
      randomSeed: "test",
    });

    const chosenQueue = stategy.chooseQueue(
      [
        {
          queue: "queue1",
          age: 4497,
          capacities: {
            queue: { current: 10, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
        {
          queue: "queue2",
          age: 19670,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 10, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
      ],
      "parentQueue",
      "selectionId"
    );

    expect(chosenQueue).toEqual({ abort: true });

    const nextSelection = await stategy.nextCandidateSelection("parentQueue");

    expect(nextSelection).toEqual({ range: [0, 3], selectionId: expect.any(String) });
  });

  it("should adjust the next candidate range ONLY for the matching parent queue", async () => {
    const stategy = new SimpleWeightedChoiceStrategy({
      queueSelectionCount: 3,
      randomSeed: "test",
    });

    const chosenQueue = stategy.chooseQueue(
      [
        {
          queue: "queue1",
          age: 4497,
          capacities: {
            queue: { current: 10, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
        {
          queue: "queue2",
          age: 19670,
          capacities: {
            queue: { current: 10, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
        {
          queue: "queue3",
          age: 12828,
          capacities: {
            queue: { current: 10, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
      ],
      "parentQueue",
      "selectionId"
    );

    expect(chosenQueue).toEqual({ abort: true });

    const nextSelection = await stategy.nextCandidateSelection("parentQueue2");

    expect(nextSelection).toEqual({ range: [0, 3], selectionId: expect.any(String) });

    const nextSelection2 = await stategy.nextCandidateSelection("parentQueue");

    expect(nextSelection2).toEqual({ range: [3, 6], selectionId: expect.any(String) });

    const chosenQueue2 = stategy.chooseQueue(
      [
        {
          queue: "queue1",
          age: 4497,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
        {
          queue: "queue2",
          age: 19670,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
        {
          queue: "queue3",
          age: 12828,
          capacities: {
            queue: { current: 0, limit: 10 },
            env: { current: 0, limit: 10 },
            org: { current: 0, limit: 10 },
          },
        },
      ],
      "parentQueue2",
      "selectionId"
    );

    expect(chosenQueue2).toEqual("queue3");

    const nextSelection3 = await stategy.nextCandidateSelection("parentQueue2");

    expect(nextSelection3).toEqual({ range: [0, 3], selectionId: expect.any(String) });
  });
});

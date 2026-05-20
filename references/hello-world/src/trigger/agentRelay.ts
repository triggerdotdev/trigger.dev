import { logger, runs, streams, task, wait } from "@trigger.dev/sdk/v3";

/**
 * Multi-agent coordination via input streams.
 *
 * Demonstrates the pattern from the Agent Relay blog post: instead of a human
 * copy-pasting context between agents, the agents talk to each other directly.
 *
 * Three "agents" (tasks) collaborate to write and review a document:
 *   - Planner: breaks the work into steps and sends them to the worker
 *   - Worker: executes each step, sends results to the reviewer
 *   - Reviewer: checks each result, sends feedback back to the worker
 *
 * The coordinator task wires them together — no human in the loop.
 */

// -- Input streams for inter-agent communication --

/** Coordinator → Agent: tells an agent who its peers are */
const connect = streams.input<{ workerRunId: string }>({
  id: "connect",
});

/** Planner → Worker: steps to execute */
const planSteps = streams.input<{ step: number; instruction: string }>({
  id: "plan-steps",
});

/** Planner → Worker: signal that all steps have been sent */
const planComplete = streams.input<{ totalSteps: number }>({
  id: "plan-complete",
});

/** Worker → Reviewer: completed work for review */
const workResult = streams.input<{ step: number; output: string }>({
  id: "work-result",
});

/** Reviewer → Worker: feedback on completed work */
const reviewFeedback = streams.input<{
  step: number;
  approved: boolean;
  comment: string;
}>({
  id: "review-feedback",
});

// -- Mock "AI" functions (replace with real LLM calls) --

function mockPlan(topic: string) {
  return [
    { step: 1, instruction: `Research the topic: ${topic}` },
    { step: 2, instruction: `Write an outline for: ${topic}` },
    { step: 3, instruction: `Draft the introduction for: ${topic}` },
  ];
}

function mockWork(instruction: string): string {
  return `[Completed] ${instruction} — Lorem ipsum dolor sit amet.`;
}

function mockReview(output: string): { approved: boolean; comment: string } {
  const approved = !output.includes("outline");
  return {
    approved,
    comment: approved ? "Looks good." : "Needs more detail in the structure.",
  };
}

// -- Agent tasks --

/**
 * Planner agent: receives a topic, breaks it into steps, sends them to the worker.
 */
export const plannerAgent = task({
  id: "agent-planner",
  run: async (payload: { topic: string; workerRunId: string }) => {
    const steps = mockPlan(payload.topic);
    logger.info("Planner: created plan", { stepCount: steps.length });

    for (const step of steps) {
      await planSteps.send(payload.workerRunId, step);
      logger.info("Planner: sent step", { step: step.step });
      await wait.for({ seconds: 1 });
    }

    await planComplete.send(payload.workerRunId, { totalSteps: steps.length });
    logger.info("Planner: all steps sent");

    return { steps: steps.length };
  },
});

/**
 * Worker agent: receives steps from the planner, executes them, sends results
 * to the reviewer, and incorporates feedback.
 */
export const workerAgent = task({
  id: "agent-worker",
  run: async (payload: { reviewerRunId: string }) => {
    const completedSteps: Array<{
      step: number;
      output: string;
      feedback: string;
    }> = [];

    let totalSteps: number | null = null;
    let stepsReceived = 0;

    // Listen for plan completion signal
    planComplete.on((data) => {
      totalSteps = data.totalSteps;
      logger.info("Worker: plan complete signal received", { totalSteps });
    });

    // Listen for review feedback
    reviewFeedback.on((data) => {
      logger.info("Worker: received feedback", { step: data.step, approved: data.approved });
      const entry = completedSteps.find((s) => s.step === data.step);
      if (entry) {
        entry.feedback = data.comment;
      }
    });

    // Process steps as they arrive
    planSteps.on(async (data) => {
      stepsReceived++;
      logger.info("Worker: received step", { step: data.step, instruction: data.instruction });

      const output = mockWork(data.instruction);
      completedSteps.push({ step: data.step, output, feedback: "" });

      // Send result to reviewer
      await workResult.send(payload.reviewerRunId, { step: data.step, output });
      logger.info("Worker: sent result to reviewer", { step: data.step });
    });

    // Wait until all steps are received and processed
    while (totalSteps === null || stepsReceived < totalSteps) {
      await wait.for({ seconds: 1 });
    }

    // Give reviewer time to send feedback
    await wait.for({ seconds: 5 });

    logger.info("Worker: all done", { completedSteps });
    return { completedSteps };
  },
});

/**
 * Reviewer agent: receives work results, reviews them, sends feedback to the
 * worker, and reports final results to the coordinator.
 *
 * The reviewer doesn't know the worker's run ID at spawn time — it receives
 * it via the `connect` input stream once the coordinator has spawned both agents.
 */
export const reviewerAgent = task({
  id: "agent-reviewer",
  run: async (payload: { expectedSteps: number }) => {
    // Wait for the coordinator to tell us who the worker is
    const { workerRunId } = await connect.once({ timeoutMs: 30_000 }).unwrap();
    logger.info("Reviewer: connected to worker", { workerRunId });

    const reviews: Array<{ step: number; approved: boolean; comment: string }> = [];

    // Review each piece of work as it arrives
    workResult.on(async (data) => {
      logger.info("Reviewer: checking step", { step: data.step });

      const review = mockReview(data.output);
      reviews.push({ step: data.step, ...review });

      // Send feedback back to worker
      await reviewFeedback.send(workerRunId, {
        step: data.step,
        ...review,
      });
      logger.info("Reviewer: sent feedback", { step: data.step, approved: review.approved });
    });

    // Wait until all steps are reviewed
    while (reviews.length < payload.expectedSteps) {
      await wait.for({ seconds: 1 });
    }

    const approved = reviews.filter((r) => r.approved).length;
    const rejected = reviews.filter((r) => !r.approved).length;
    const summary = `Reviewed ${reviews.length} steps. ${approved} approved, ${rejected} need revision.`;

    logger.info("Reviewer: done", { summary });
    return { reviews, summary };
  },
});

/**
 * Coordinator: wires the agents together and collects results.
 *
 * This is the orchestrator — it spawns the agents, connects them via input
 * streams, and waits for everything to complete. No human in the loop.
 */
export const agentRelayCoordinator = task({
  id: "agent-relay-coordinator",
  run: async (payload: { topic?: string }) => {
    const topic = payload.topic ?? "The future of multi-agent systems";
    logger.info("Coordinator: starting multi-agent workflow", { topic });

    // Spawn worker and reviewer (order doesn't matter — they wait for connections)
    const reviewerHandle = await reviewerAgent.trigger({ expectedSteps: 3 });
    const workerHandle = await workerAgent.trigger({
      reviewerRunId: reviewerHandle.id,
    });

    logger.info("Coordinator: agents spawned", {
      workerId: workerHandle.id,
      reviewerId: reviewerHandle.id,
    });

    // Tell the reviewer who the worker is so it can send feedback
    await connect.send(reviewerHandle.id, { workerRunId: workerHandle.id });

    // Spawn the planner — it sends steps directly to the worker
    const plannerHandle = await plannerAgent.trigger({
      topic,
      workerRunId: workerHandle.id,
    });

    logger.info("Coordinator: planner spawned, waiting for completion", {
      plannerId: plannerHandle.id,
    });

    // Wait for all agents to complete
    const [plannerRun, workerRun, reviewerRun] = await Promise.all([
      runs.poll(plannerHandle, { pollIntervalMs: 2000 }),
      runs.poll(workerHandle, { pollIntervalMs: 2000 }),
      runs.poll(reviewerHandle, { pollIntervalMs: 2000 }),
    ]);

    logger.info("Coordinator: all agents complete", {
      planner: plannerRun.output,
      worker: workerRun.output,
      reviewer: reviewerRun.output,
    });

    return {
      topic,
      planner: plannerRun.output,
      worker: workerRun.output,
      reviewer: reviewerRun.output,
    };
  },
});

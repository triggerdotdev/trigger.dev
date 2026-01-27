/**
 * Cloudflare Worker Test Fixture
 *
 * Tests that the SDK can be bundled for Cloudflare Workers (workerd runtime).
 * This validates the bundling process works - actual execution would require
 * a Trigger.dev API connection.
 */

import { task, runs, configure } from "@trigger.dev/sdk";

// Define a task (won't execute in worker, but validates import)
const myTask = task({
  id: "cloudflare-test-task",
  run: async (payload: { message: string }) => {
    return { received: payload.message };
  },
});

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    // Validate SDK imports work
    const checks = {
      taskDefined: typeof task === "function",
      runsDefined: typeof runs === "object",
      configureDefined: typeof configure === "function",
      taskIdCorrect: myTask.id === "cloudflare-test-task",
    };

    const allPassed = Object.values(checks).every((v) => v === true);

    return new Response(
      JSON.stringify({
        success: allPassed,
        checks,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  },
};

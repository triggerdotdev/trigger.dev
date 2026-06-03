import type { ToolContext, RunWithTrace } from "../types";
import { summarizeRun, summarizeTrace } from "./run-formatters";

export async function getRunForLLM(
  ctx: ToolContext,
  runFriendlyId: string
): Promise<RunWithTrace | null> {
  try {
    // Dynamic import keeps `~/db.server` / `~/v3/tracer.server` off the module graph
    // during CLI indexing (index worker already registers its own TracingSDK).
    const { RunPresenter } = await import("~/presenters/v3/RunPresenter.server");
    const presenter = new RunPresenter();
    const result = await presenter.call({
      userId: ctx.clientData.userId,
      projectSlug: ctx.clientData.projectSlug,
      environmentSlug: ctx.clientData.environmentSlug,
      runFriendlyId,
      showDeletedLogs: false,
      showDebug: false,
    });

    return {
      run: summarizeRun(result.run),
      trace: result.trace ? summarizeTrace(result.trace) : undefined,
    };
  } catch (error) {
    return null;
  }
}

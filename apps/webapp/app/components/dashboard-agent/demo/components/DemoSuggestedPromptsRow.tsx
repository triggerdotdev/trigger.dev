/**
 * What the page-aware prompt row should look like once M4's registry resolves
 * chips from the page context.
 *
 * The production `DashboardAgentSuggestedPrompts` is a static list with no
 * notion of a promoted chip or a dismissal, so this demo row exists to show the
 * two things the review has to settle: how a promoted chip is distinguished from
 * the rest, and what dismissing one leaves behind. It renders the same
 * `SuggestedPrompt[]` the registry will produce, capped the same way.
 */
import { XMarkIcon } from "@heroicons/react/20/solid";
import {
  SUGGESTED_PROMPT_CAP,
  type AgentPageContext,
  type SuggestedPrompt,
} from "@internal/dashboard-agent-contracts";
import { cn } from "~/utils/cn";

/** One line describing the page the chips were derived from. */
function contextLine(context: AgentPageContext): string {
  const { page, signals } = context;
  const where =
    page.kind === "run"
      ? `run ${page.runId} · ${page.status}`
      : page.kind === "runs"
        ? "runs list"
        : page.kind === "queue"
          ? `queue ${page.name}`
          : page.kind === "error"
            ? `error ${page.fingerprint}`
            : page.kind === "deployment"
              ? `deployment ${page.version}`
              : page.path;
  const why = signals.length > 0 ? signals.map((s) => s.kind).join(", ") : "no signals";
  return `${where} — ${why}`;
}

export function DemoSuggestedPromptsRow({
  prompts,
  context,
  dismissedIds = [],
  onSelect,
  onDismiss,
}: {
  prompts: SuggestedPrompt[];
  /** Shown above the chips so a reviewer can see what produced them. */
  context?: AgentPageContext;
  dismissedIds?: string[];
  onSelect?: (prompt: SuggestedPrompt) => void;
  onDismiss?: (prompt: SuggestedPrompt) => void;
}) {
  const visible = prompts
    .filter((prompt) => !dismissedIds.includes(prompt.id))
    .slice(0, SUGGESTED_PROMPT_CAP);

  return (
    <div className="space-y-1.5">
      {context ? (
        <p className="text-[10px] uppercase tracking-wide text-text-faint">
          {contextLine(context)}
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        {visible.map((prompt) => (
          <div key={prompt.id} className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSelect?.(prompt)}
              className={cn(
                "flex-1 rounded-md border px-3 py-2 text-left text-sm transition",
                prompt.source === "promoted"
                  ? "border-indigo-500/40 bg-indigo-500/5 text-text-bright hover:border-indigo-500/60"
                  : "border-grid-bright bg-background-bright/40 text-text-dimmed hover:border-border-bright hover:text-text-bright"
              )}
            >
              {prompt.label}
            </button>
            <button
              type="button"
              aria-label={`Dismiss ${prompt.label}`}
              onClick={() => onDismiss?.(prompt)}
              className="shrink-0 rounded p-1 text-text-faint opacity-0 transition-opacity hover:text-text-bright group-hover:opacity-100 focus-visible:opacity-100"
            >
              <XMarkIcon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      {dismissedIds.length > 0 ? (
        <p className="text-[10px] text-text-faint">
          {dismissedIds.length} dismissed — not offered again on this page.
        </p>
      ) : null}
    </div>
  );
}

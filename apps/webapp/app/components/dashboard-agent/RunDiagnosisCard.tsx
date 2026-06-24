import { Link } from "@remix-run/react";
import type { DiagnosisBlock } from "@internal/dashboard-agent";
import { Badge } from "~/components/primitives/Badge";
import { toSafeUrl } from "~/components/runs/v3/agent/AgentMessageView";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { v3RunPath } from "~/utils/pathBuilder";

// The "why did this run fail?" failure card — the first block in the dashboard
// agent's view catalog. Rendered from a `diagnosis` block the agent emits via
// the render_view tool (see internal-packages/dashboard-agent tool-schemas).
// Everything here is plain presentation of validated fields; no markup comes
// from the model, so there's nothing to sanitize beyond outbound URLs.

const CATEGORY_LABELS: Record<DiagnosisBlock["category"], string> = {
  user_code_error: "Code error",
  configuration: "Configuration",
  dependency: "Dependency",
  timeout: "Timeout",
  out_of_memory: "Out of memory",
  rate_limit: "Rate limit",
  external_service: "External service",
  infrastructure: "Infrastructure",
  cancellation: "Cancelled",
  unknown: "Unknown",
};

const CONFIDENCE_STYLES: Record<DiagnosisBlock["confidence"], string> = {
  high: "border-emerald-500/40 text-emerald-400",
  medium: "border-amber-500/40 text-amber-400",
  low: "border-charcoal-600 text-text-dimmed",
};

const EVIDENCE_LABELS: Record<DiagnosisBlock["evidence"][number]["type"], string> = {
  error: "Error",
  failed_span: "Failed span",
  child_run: "Child run",
  logs: "Logs",
  deploy: "Deploy",
  source: "Source",
  historical_match: "History",
};

// Build a run-page path in the current org/project/env, or null when that route
// context is absent (e.g. the storybook page) so the card degrades to plain
// text rather than throwing.
function useRunPath(runId: string): string | null {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();
  if (!organization || !project || !environment) return null;
  return v3RunPath(organization, project, environment, { friendlyId: runId });
}

// Internal link to a run page, built from the canonical path builder so it stays
// correct if the route shape changes. Falls back to plain text off-context.
function RunLink({ runId, className }: { runId: string; className?: string }) {
  const to = useRunPath(runId);
  if (!to) return <span className={cn("font-mono text-text-dimmed", className)}>{runId}</span>;
  return (
    <Link to={to} className={cn("text-indigo-400 underline hover:text-indigo-300", className)}>
      {runId}
    </Link>
  );
}

// Render an evidence `reference`: a run id links to its run page, an https URL
// becomes an external link, everything else (error id, file:line, version) is
// shown as monospace text.
function EvidenceReference({ reference }: { reference: string }) {
  if (/^run_[a-z0-9]+$/i.test(reference)) {
    return <RunLink runId={reference} className="font-mono text-xs" />;
  }
  const safeUrl = toSafeUrl(reference);
  if (safeUrl) {
    return (
      <a
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-xs text-indigo-400 underline hover:text-indigo-300"
      >
        {reference}
      </a>
    );
  }
  return <span className="font-mono text-xs text-text-dimmed">{reference}</span>;
}

function DiagnosisActions({ actions }: { actions: NonNullable<DiagnosisBlock["actions"]> }) {
  const buttonClass =
    "inline-flex items-center rounded border border-charcoal-600 bg-charcoal-800 px-2.5 py-1 text-xs text-text-bright transition-colors hover:border-charcoal-500 hover:bg-charcoal-750";
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {actions.map((action, i) => {
        if (action.kind === "view_run" && /^run_[a-z0-9]+$/i.test(action.target)) {
          return <RunActionButton key={i} runId={action.target} label={action.label} className={buttonClass} />;
        }
        if (action.kind === "docs") {
          const safeUrl = toSafeUrl(action.target);
          if (!safeUrl) return null;
          return (
            <a
              key={i}
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass}
            >
              {action.label}
            </a>
          );
        }
        return null;
      })}
    </div>
  );
}

function RunActionButton({
  runId,
  label,
  className,
}: {
  runId: string;
  label: string;
  className: string;
}) {
  const to = useRunPath(runId);
  if (!to) return <span className={className}>{label}</span>;
  return (
    <Link to={to} className={className}>
      {label}
    </Link>
  );
}

export function RunDiagnosisCard({ block }: { block: DiagnosisBlock }) {
  const evidence = block.evidence ?? [];
  const nextSteps = block.nextSteps ?? [];
  const actions = block.actions ?? [];

  return (
    <div className="overflow-hidden rounded-lg border border-charcoal-600 bg-charcoal-850">
      <div className="flex flex-wrap items-center gap-2 border-b border-charcoal-700 bg-charcoal-800 px-3 py-2">
        <span className="text-xs font-medium text-text-dimmed">Run diagnosis</span>
        <Badge variant="small" className="border-rose-500/40 text-rose-400">
          {CATEGORY_LABELS[block.category] ?? block.category}
        </Badge>
        <Badge variant="small" className={cn("uppercase", CONFIDENCE_STYLES[block.confidence])}>
          {block.confidence} confidence
        </Badge>
        {block.runId ? <RunLink runId={block.runId} className="ml-auto font-mono text-xs" /> : null}
      </div>

      <div className="space-y-3 px-3 py-3">
        <p className="text-sm text-text-bright">{block.summary}</p>

        <Section title="Likely cause">
          <p className="text-sm text-text-dimmed">{block.likelyCause}</p>
        </Section>

        {evidence.length > 0 ? (
          <Section title="Evidence">
            <ul className="space-y-1.5">
              {evidence.map((item, i) => (
                <li key={i} className="text-xs text-text-dimmed">
                  <span className="mr-1.5 rounded-sm bg-charcoal-700 px-1 py-0.5 text-[10px] uppercase tracking-wide text-text-dimmed">
                    {EVIDENCE_LABELS[item.type] ?? item.type}
                  </span>
                  <span className="text-text-bright">{item.detail}</span>
                  {item.reference ? (
                    <span className="ml-1.5">
                      <EvidenceReference reference={item.reference} />
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {block.impact ? (
          <Section title="Impact">
            <p className="text-sm text-text-dimmed">{block.impact}</p>
          </Section>
        ) : null}

        {nextSteps.length > 0 ? (
          <Section title="Next steps">
            <ol className="list-decimal space-y-1 pl-4">
              {nextSteps.map((step, i) => (
                <li key={i} className="text-sm text-text-dimmed">
                  {step}
                </li>
              ))}
            </ol>
          </Section>
        ) : null}

        {actions.length > 0 ? <DiagnosisActions actions={actions} /> : null}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium uppercase tracking-wide text-text-dimmed">{title}</h4>
      {children}
    </div>
  );
}

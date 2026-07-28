import { BookOpenIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import type { DiagnosisBlock } from "@internal/dashboard-agent";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { toSafeUrl } from "~/components/runs/v3/agent/AgentMessageView";
import { CategoryBadge, ConfidenceBadge, EVIDENCE_ROW_CLASS } from "./agent-badges";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { v3RunPath } from "~/utils/pathBuilder";
import { isRunFriendlyId } from "./run-id";

// The "why did this run fail?" failure card — the first block in the dashboard
// agent's view catalog. Rendered from a `diagnosis` block the agent emits via
// the render_view tool (see internal-packages/dashboard-agent tool-schemas).
// Everything here is plain presentation of validated fields; no markup comes
// from the model, so there's nothing to sanitize beyond outbound URLs.

// The category as one humanized sentence answering the triage question: whose
// problem is this, roughly? Key words carry the weight, not a label prefix.
function Em({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold text-text-bright">{children}</span>;
}

const CATEGORY_SENTENCES: Record<DiagnosisBlock["category"], React.ReactNode> = {
  user_code_error: (
    <>
      A <Em>bug</Em> in the task's own code
    </>
  ),
  configuration: (
    <>
      A <Em>misconfigured setting</Em> on the task, queue or environment
    </>
  ),
  dependency: (
    <>
      A <Em>package or build dependency</Em> problem
    </>
  ),
  timeout: (
    <>
      The run hit its <Em>time limit</Em>
    </>
  ),
  out_of_memory: (
    <>
      The run ran out of <Em>memory</Em>
    </>
  ),
  rate_limit: (
    <>
      A <Em>rate limit</Em> was hit
    </>
  ),
  external_service: (
    <>
      A <Em>third-party service</Em> the task calls failed
    </>
  ),
  infrastructure: (
    <>
      A <Em>platform-side</Em> problem — not your code
    </>
  ),
  cancellation: (
    <>
      The run was <Em>cancelled</Em> before finishing
    </>
  ),
  unknown: (
    <>
      The cause <Em>couldn't be classified</Em>
    </>
  ),
};

// Matches the app's link convention (TextLink `primary`), which holds up in both
// themes.
const LINK_STYLE = "text-indigo-500 transition hover:text-indigo-400";

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
    <Link to={to} className={cn(LINK_STYLE, "underline", className)}>
      {runId}
    </Link>
  );
}

// Render an evidence `reference`: a run id links to its run page, an https URL
// becomes an external link, everything else (error id, file:line, version) is
// shown as monospace text.
function EvidenceReference({ reference }: { reference: string }) {
  if (isRunFriendlyId(reference)) {
    return <RunLink runId={reference} className="font-mono text-xs" />;
  }
  const safeUrl = toSafeUrl(reference);
  if (safeUrl) {
    return (
      <a
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(LINK_STYLE, "font-mono text-xs underline")}
      >
        {reference}
      </a>
    );
  }
  return <span className="font-mono text-xs text-text-dimmed">{reference}</span>;
}

function DiagnosisActions({ actions }: { actions: NonNullable<DiagnosisBlock["actions"]> }) {
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {actions.map((action, i) => {
        if (action.kind === "view_run" && isRunFriendlyId(action.target)) {
          return <RunActionButton key={i} runId={action.target} label={action.label} />;
        }
        if (action.kind === "docs") {
          const safeUrl = toSafeUrl(action.target);
          if (!safeUrl) return null;
          return (
            <LinkButton key={i} to={safeUrl} variant="docs/small" LeadingIcon={BookOpenIcon}>
              {action.label}
            </LinkButton>
          );
        }
        return null;
      })}
    </div>
  );
}

function RunActionButton({ runId, label }: { runId: string; label: string }) {
  const to = useRunPath(runId);
  // Off-context (e.g. the storybook page) there is nowhere to go, so the button
  // stays visible but disabled rather than becoming plain text.
  if (!to) {
    return (
      <Button variant="primary/small" disabled>
        {label}
      </Button>
    );
  }
  return (
    <LinkButton to={to} variant="primary/small">
      {label}
    </LinkButton>
  );
}

export function RunDiagnosisCard({ block }: { block: DiagnosisBlock }) {
  const evidence = block.evidence ?? [];
  const nextSteps = block.nextSteps ?? [];
  const actions = block.actions ?? [];

  return (
    <div className="overflow-hidden rounded-lg border border-border-bright bg-background-dimmed">
      <div className="space-y-1.5 border-b border-grid-bright bg-background-bright px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-text-dimmed">Run diagnosis</span>
          <ConfidenceBadge confidence={block.confidence} />
          {block.runId ? (
            <RunLink runId={block.runId} className="ml-auto font-mono text-xs" />
          ) : null}
        </div>
        {/* The category as one humanized subtitle sentence; the key words are
            bold, no label prefix. */}
        <p className="text-sm text-text-dimmed">
          {CATEGORY_SENTENCES[block.category] ?? block.category}
        </p>
      </div>

      <div className="space-y-5 px-4 py-4">
        <p className="text-sm text-text-bright">{block.summary}</p>

        <Section title="Likely cause">
          <p className="text-sm text-text-dimmed">{block.likelyCause}</p>
        </Section>

        {evidence.length > 0 ? (
          <Section title="Evidence">
            {/* Two columns: the type badges line up in a fixed left column, the
                detail and its reference line up in the second. */}
            <ul className="space-y-3">
              {evidence.map((item, i) => (
                <li key={i} className={EVIDENCE_ROW_CLASS}>
                  <CategoryBadge className="justify-self-start">
                    {EVIDENCE_LABELS[item.type] ?? item.type}
                  </CategoryBadge>
                  <div className="min-w-0 space-y-1 text-xs">
                    <p className="text-text-bright">{item.detail}</p>
                    {item.reference ? (
                      <div className="break-all">
                        <EvidenceReference reference={item.reference} />
                      </div>
                    ) : null}
                  </div>
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
            <ol className="list-decimal space-y-2 pl-5">
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
    <div className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-text-dimmed">{title}</h4>
      {children}
    </div>
  );
}

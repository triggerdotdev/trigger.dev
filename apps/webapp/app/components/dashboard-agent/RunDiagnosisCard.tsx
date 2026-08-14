import { BookOpenIcon } from "@heroicons/react/20/solid";
import type { DiagnosisBlock } from "@internal/dashboard-agent";
import { LinkButton } from "~/components/primitives/Buttons";
import { TextLink } from "~/components/primitives/TextLink";
import { toSafeUrl } from "~/components/runs/v3/agent/AgentMessageView";
import { CategoryBadge, ConfidenceBadge, EVIDENCE_ROW_CLASS } from "./agent-badges";
import { AgentCard, AgentCardBody, AgentCardHeader } from "./agent-card";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { v3RunPath } from "~/utils/pathBuilder";
import { planDiagnosisActions } from "./diagnosis-actions";
import { isRunFriendlyId } from "./run-id";

// No markup comes from the model, so only outbound URLs need checking.

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

const EVIDENCE_LABELS: Record<DiagnosisBlock["evidence"][number]["type"], string> = {
  error: "Error",
  failed_span: "Failed span",
  child_run: "Child run",
  logs: "Logs",
  deploy: "Deploy",
  source: "Source",
  historical_match: "History",
};

// Null when the route context is absent, so the card degrades to plain text.
function useRunPathResolver(): (runId: string) => string | null {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();
  return (runId) =>
    organization && project && environment
      ? v3RunPath(organization, project, environment, { friendlyId: runId })
      : null;
}

function useRunPath(runId: string): string | null {
  return useRunPathResolver()(runId);
}

function RunLink({ runId, className }: { runId: string; className?: string }) {
  const to = useRunPath(runId);
  if (!to) return <span className={cn("font-mono text-text-dimmed", className)}>{runId}</span>;
  return (
    <TextLink to={to} className={className}>
      {runId}
    </TextLink>
  );
}

function EvidenceReference({ reference }: { reference: string }) {
  if (isRunFriendlyId(reference)) {
    return <RunLink runId={reference} className="font-mono text-xs" />;
  }
  const safeUrl = toSafeUrl(reference);
  if (safeUrl) {
    return (
      <TextLink
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-xs"
      >
        {reference}
      </TextLink>
    );
  }
  return <span className="font-mono text-xs text-text-dimmed">{reference}</span>;
}

function DiagnosisActions({ actions }: { actions: NonNullable<DiagnosisBlock["actions"]> }) {
  const runPath = useRunPathResolver();
  const planned = planDiagnosisActions(actions, {
    runPath,
    docsUrl: (target) => toSafeUrl(target),
  });
  if (planned.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {planned.map((action, i) =>
        action.kind === "docs" ? (
          <LinkButton key={i} to={action.to} variant="docs/small" LeadingIcon={BookOpenIcon}>
            {action.label}
          </LinkButton>
        ) : (
          <LinkButton key={i} to={action.to} variant="primary/small">
            {action.label}
          </LinkButton>
        )
      )}
    </div>
  );
}

export function RunDiagnosisCard({ block }: { block: DiagnosisBlock }) {
  const evidence = block.evidence ?? [];
  const nextSteps = block.nextSteps ?? [];
  const actions = block.actions ?? [];

  return (
    <AgentCard>
      <AgentCardHeader className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-text-dimmed">Run diagnosis</span>
          <ConfidenceBadge confidence={block.confidence} />
        </div>
        <p className="text-sm text-text-dimmed">
          {CATEGORY_SENTENCES[block.category] ?? block.category}
        </p>
        {block.runId ? (
          <div className="truncate">
            {/* `block` so the ellipsis still lands: the link itself is inline-flex. */}
            <RunLink runId={block.runId} className="block truncate font-mono text-xs" />
          </div>
        ) : null}
      </AgentCardHeader>

      <AgentCardBody density="roomy">
        <p className="text-sm text-text-bright">{block.summary}</p>

        <Section title="Likely cause">
          <p className="text-sm text-text-dimmed">{block.likelyCause}</p>
        </Section>

        {evidence.length > 0 ? (
          <Section title="Evidence">
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
      </AgentCardBody>
    </AgentCard>
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

/**
 * The badges the agent's cards use, and the matching status icons. Geometry
 * comes from the `Badge` primitive's `small` variant, so every chip is the same
 * box and only colour and icon differ.
 */
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  NoSymbolIcon,
  QuestionMarkCircleIcon,
} from "@heroicons/react/20/solid";
import { Badge } from "~/components/primitives/Badge";
import { cn } from "~/utils/cn";

export type AgentTone = "neutral" | "success" | "warning" | "error";

// Semantic tokens, not raw palette classes: raw ones are dark-theme only, and
// the theme layer remaps these (see tailwind.css). The `system:` overrides are
// required because the Badge `small` variant otherwise tints every chip blue on
// the system themes.
const TONE_BADGE: Record<AgentTone, string> = {
  neutral:
    "border-border-bright text-text-dimmed system:border-transparent system:bg-charcoal-500/10 system:text-text-dimmed",
  success:
    "border-success/40 text-success system:border-transparent system:bg-success/10 system:text-success",
  warning:
    "border-warning/40 text-warning system:border-transparent system:bg-warning/10 system:text-warning",
  error:
    "border-error/40 text-error system:border-transparent system:bg-error/10 system:text-error",
};

export const TONE_ICON_COLOR: Record<AgentTone, string> = {
  neutral: "text-text-dimmed",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
};

type IconComponent = (props: { className?: string }) => JSX.Element;

export function AgentBadge({
  tone = "neutral",
  icon: Icon,
  className,
  children,
}: {
  tone?: AgentTone;
  icon?: IconComponent;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Badge
      variant="small"
      className={cn(
        "px-1.5 [&>span]:flex [&>span]:items-center [&>span]:gap-1",
        TONE_BADGE[tone],
        className
      )}
    >
      {Icon ? <Icon className="size-3 shrink-0" /> : null}
      {children}
    </Badge>
  );
}

/** A failure category, an evidence type: anything that classifies, not grades. */
export function CategoryBadge({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AgentBadge tone="neutral" className={className}>
      {children}
    </AgentBadge>
  );
}

export type AgentConfidence = "high" | "medium" | "low";

const CONFIDENCE_TONE: Record<AgentConfidence, AgentTone> = {
  high: "success",
  medium: "warning",
  low: "neutral",
};

const CONFIDENCE_ICON: Record<AgentConfidence, IconComponent> = {
  high: CheckCircleIcon,
  medium: ExclamationTriangleIcon,
  low: QuestionMarkCircleIcon,
};

const CONFIDENCE_LABEL: Record<AgentConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

export function ConfidenceBadge({ confidence }: { confidence: AgentConfidence }) {
  return (
    <AgentBadge tone={CONFIDENCE_TONE[confidence]} icon={CONFIDENCE_ICON[confidence]}>
      {CONFIDENCE_LABEL[confidence]}
    </AgentBadge>
  );
}

export type AgentSeverity = "info" | "warn" | "crit";

const SEVERITY_TONE: Record<AgentSeverity, AgentTone> = {
  info: "neutral",
  warn: "warning",
  crit: "error",
};

const SEVERITY_ICON: Record<AgentSeverity, IconComponent> = {
  info: InformationCircleIcon,
  warn: ExclamationTriangleIcon,
  crit: ExclamationCircleIcon,
};

export function SeverityBadge({
  severity,
  children,
}: {
  severity: AgentSeverity;
  children: React.ReactNode;
}) {
  return (
    <AgentBadge tone={SEVERITY_TONE[severity]} icon={SEVERITY_ICON[severity]}>
      {children}
    </AgentBadge>
  );
}

export type AgentVerdict = "testing" | "validated" | "invalidated";

const VERDICT_TONE: Record<AgentVerdict, AgentTone> = {
  testing: "neutral",
  validated: "success",
  invalidated: "neutral",
};

const VERDICT_ICON: Record<AgentVerdict, IconComponent | undefined> = {
  testing: undefined,
  validated: CheckCircleIcon,
  invalidated: NoSymbolIcon,
};

export function VerdictBadge({
  verdict,
  children,
}: {
  verdict: AgentVerdict;
  children: React.ReactNode;
}) {
  return (
    <AgentBadge tone={VERDICT_TONE[verdict]} icon={VERDICT_ICON[verdict]}>
      {children}
    </AgentBadge>
  );
}

/**
 * One evidence row: fixed left column for the type badge, the rest for text.
 * Shared so the diagnosis and investigation cards align identically.
 */
export const EVIDENCE_ROW_CLASS = "grid grid-cols-[6.5rem_1fr] items-start gap-x-3";

/** A coloured state icon for a status line whose text stays the default colour. */
export function AgentStatusIcon({
  tone,
  icon: Icon,
  className,
}: {
  tone: AgentTone;
  icon: IconComponent;
  className?: string;
}) {
  return <Icon className={cn("size-4 shrink-0", TONE_ICON_COLOR[tone], className)} />;
}

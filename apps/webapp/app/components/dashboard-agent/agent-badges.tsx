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

// Semantic tokens, not raw palette classes: raw ones are dark-theme only.
// The `system:` overrides stop the Badge `small` variant tinting every chip blue.
const TONE_BADGE: Record<AgentTone, string> = {
  neutral:
    "border-border-bright text-text-dimmed system:border-transparent system:bg-charcoal-500 system:text-white",
  success:
    "border-success/40 text-success system:border-transparent system:bg-success system:text-white",
  warning:
    "border-warning/40 text-warning system:border-transparent system:bg-warning system:text-white",
  error: "border-error/40 text-error system:border-transparent system:bg-error system:text-white",
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
        // No `contrast-chip` here: that ring is drawn in currentcolor to give a
        // low-contrast tint a visible edge, and these fill solid with a white
        // label under the preference - so it landed as a white line inset into
        // the fill.
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

export const EVIDENCE_ROW_CLASS = "grid grid-cols-[6.5rem_1fr] items-start gap-x-3";

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

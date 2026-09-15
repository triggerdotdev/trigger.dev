// Model prose, which may hold canonical `trigger://` links the producer wrote in. An
// unresolvable URI renders as plain text, so a card never shows a dead link.
import { Suspense, type ReactNode } from "react";
import { StreamdownRenderer, TriggerAwareAnchor } from "~/components/code/StreamdownRenderer";
import { textLinkClassName } from "~/components/primitives/TextLink";
import { cn } from "~/utils/cn";
import {
  AgentMarkdownTable,
  AgentMarkdownTableBody,
  AgentMarkdownTableCell,
  AgentMarkdownTableHead,
  AgentMarkdownTableHeaderCell,
  AgentMarkdownTableRow,
} from "./AgentMarkdownTable";
import type { ResolvedUri } from "./ReportView";

// The default streamdown anchor relies on `.streamdown-container a` for its link color, which
// doesn't reach a link rendered in the table's fullscreen dialog (portaled outside that
// container). Apply the app's standard link styling directly instead, reusing the trigger://
// resolution from `TriggerAwareAnchor` rather than forking it.
export function AgentAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <TriggerAwareAnchor href={href} className={textLinkClassName()}>
      {children}
    </TriggerAwareAnchor>
  );
}

const AGENT_STREAMDOWN_COMPONENTS = {
  a: AgentAnchor,
  table: AgentMarkdownTable,
  thead: AgentMarkdownTableHead,
  tbody: AgentMarkdownTableBody,
  tr: AgentMarkdownTableRow,
  td: AgentMarkdownTableCell,
  th: AgentMarkdownTableHeaderCell,
};

export function AgentText({
  text,
  className,
  resolveUri,
}: {
  text: string;
  className?: string;
  resolveUri?: (uri: string) => ResolvedUri | null;
}) {
  return (
    <div className={cn("streamdown-container min-w-0 wrap-anywhere", className)}>
      <Suspense fallback={<span className="whitespace-pre-wrap">{text}</span>}>
        <StreamdownRenderer resolveTriggerUri={resolveUri} components={AGENT_STREAMDOWN_COMPONENTS}>
          {text}
        </StreamdownRenderer>
      </Suspense>
    </div>
  );
}

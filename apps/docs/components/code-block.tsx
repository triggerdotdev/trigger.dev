import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { personalizationEnabled } from "@/lib/dashboard-link";
import { sampleAccess } from "@/lib/api-access";
import { findPlaceholders } from "@/lib/placeholders";
import { PersonalizedSample } from "./personalized-sample";
import { TaskTestSample } from "./task-test";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return Children.toArray(node).map(textOf).join("");
}

// Every code sample renders through here. Samples with a reader placeholder (lib/placeholders.ts)
// render client-side so a signed-in reader sees their own project ref and docs key; the rest stay
// as plain server-rendered blocks. Task samples get "Test in dashboard" (lib/remark-task-test.ts).
export function CodeSample({
  "data-task-test": taskTest,
  ...props
}: ComponentProps<"pre"> & { "data-task-test"?: string }) {
  if (personalizationEnabled) {
    const text = textOf(props.children);
    const needs = findPlaceholders(text);
    // Only samples with somewhere to put a key offer one; SDK calls the default docs key doesn't
    // cover (env vars, schedules, ...) then ask for a key with the matching access.
    if (needs.projectRef || needs.devKey) {
      return (
        <PersonalizedSample
          {...props}
          needsDevKey={needs.devKey}
          access={needs.devKey ? sampleAccess(text) : null}
          taskTest={taskTest}
        />
      );
    }
  }
  // The dashboard's Test page reads the sample payload only once the docs reader routes ship, which
  // is when personalization turns on.
  if (taskTest && personalizationEnabled) return <TaskTestSample {...props} taskTest={taskTest} />;
  return (
    <CodeBlock {...props}>
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}

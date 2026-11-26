"use client";

import type { ComponentProps, ReactNode } from "react";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { FlaskConical } from "lucide-react";
import { dashboardLink } from "@/lib/dashboard-link";
import { useReaderProject } from "@/lib/reader";

/**
 * "Test in dashboard" on a task sample: the dashboard Test page for that task with the sample's
 * payload in the editor. Signed in, it opens the project picked in the docs; otherwise the
 * dashboard picks the reader's last project (after login if needed).
 */
function TestTaskLink({ path }: { path: string }) {
  const projectRef = useReaderProject()?.ref;
  return (
    <a
      href={dashboardLink(path, projectRef)}
      target="_blank"
      rel="noopener"
      title="Open the Test page for this task with this payload"
      className="inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-fd-primary transition-colors hover:bg-fd-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-fd-ring [&_svg]:size-3.5"
    >
      <FlaskConical />
      Test in dashboard
    </a>
  );
}

/** Code block actions with the Test link before the copy button (`taskTest`: lib/remark-task-test.ts). */
export function taskTestActions(taskTest: string | undefined) {
  if (!taskTest) return undefined;
  return function Actions({ className, children }: { className?: string; children?: ReactNode }) {
    return (
      <div className={`flex items-center gap-1 ${className ?? ""}`}>
        <TestTaskLink path={taskTest} />
        {children}
      </div>
    );
  };
}

/** A plain (not personalized) sample with a Test link. */
export function TaskTestSample({
  taskTest,
  ...props
}: ComponentProps<"pre"> & { taskTest: string }) {
  return (
    <CodeBlock {...props} Actions={taskTestActions(taskTest)}>
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}

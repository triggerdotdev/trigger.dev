"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { signInLink } from "@/lib/dashboard-link";
import { fillParts, findPlaceholders } from "@/lib/placeholders";
import { DEFAULT_NEED, useCoveringKey } from "@/lib/docs-keys";
import { useReader, useReaderProject } from "@/lib/reader";
import { LogIn } from "lucide-react";
import { DocsKeyHint, KeyBar, primaryLink } from "./docs-key-hint";
import { taskTestActions } from "./task-test";

// The server-rendered text of each placeholder node, so a project switch or sign-out restores it.
const originals = new WeakMap<Text, string>();

/** Fill the placeholders in the rendered sample's text. Works on the DOM, not the React tree, so it
 * doesn't depend on how the highlighter splits or streams the code. Line by line, so a placeholder
 * the highlighter split into several tokens (`<project-ref>` in shell) still fills. */
function fillText(root: HTMLElement, projectRef?: string, devKey?: string) {
  const lines = root.querySelectorAll<HTMLElement>(".line");
  for (const line of lines.length ? lines : [root]) {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    const parts = nodes.map((node) => originals.get(node) ?? node.data);
    const found = findPlaceholders(parts.join(""));
    if (!found.projectRef && !found.devKey) continue;
    const filled = fillParts(parts, { projectRef, devKey });
    nodes.forEach((node, i) => {
      if (!originals.has(node)) originals.set(node, parts[i]!);
      if (node.data !== filled[i]) node.data = filled[i]!;
    });
  }
}

/** A code sample showing the signed-in reader's project ref and docs key in place of placeholders. */
export function PersonalizedSample({
  needsDevKey,
  access,
  taskTest,
  className,
  ...props
}: ComponentProps<"pre"> & { needsDevKey: boolean; access: string[] | null; taskTest?: string }) {
  const reader = useReader();
  const project = useReaderProject();
  const needed = access ?? DEFAULT_NEED;
  const key = useCoveringKey(needsDevKey ? project : null, needed);
  const ref = useRef<HTMLDivElement>(null);
  const projectRef = project?.ref;
  const devKey = key?.apiKey;

  useLayoutEffect(() => {
    if (ref.current) fillText(ref.current, projectRef, devKey);
  }, [projectRef, devKey]);

  return (
    <>
      {/* ph-no-capture: the reader's own values never reach analytics. */}
      <div ref={ref} className="contents">
        <CodeBlock
          {...props}
          className={`${className ?? ""} ph-no-capture`}
          Actions={taskTestActions(taskTest)}
        >
          <Pre>{props.children}</Pre>
        </CodeBlock>
      </div>
      {reader.kind === "anonymous" && <SignInHint needsDevKey={needsDevKey} />}
      {project && needsDevKey && (
        <DocsKeyHint
          project={project}
          needed={needed}
          access={access}
          what="sample"
          className="-mt-2.5 mb-5"
        />
      )}
    </>
  );
}

function SignInHint({ needsDevKey }: { needsDevKey: boolean }) {
  // The current page URL is only known in the browser.
  const [href, setHref] = useState<string>();
  useEffect(() => setHref(signInLink(window.location.href)), []);
  if (!href) return null;

  return (
    <KeyBar
      className="-mt-2.5 mb-5"
      title={
        needsDevKey ? "Sign in to fill in your own key" : "Sign in to fill in your project ref"
      }
      hint="Samples on this page then use your project."
      actions={
        <a href={href} className={primaryLink}>
          <LogIn />
          Sign in
        </a>
      }
    />
  );
}

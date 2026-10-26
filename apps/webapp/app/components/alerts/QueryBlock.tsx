import { CodeBlock } from "~/components/code/CodeBlock";

export function QueryBlock({ query }: { query: string }) {
  return (
    <div data-testid="query-alert-query">
      <CodeBlock
        className="max-h-40 [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
        code={query}
        showCopyButton={false}
        showOpenInModal={false}
        showLineNumbers={false}
        language="sql"
        wrap
      />
    </div>
  );
}

import { useEffect } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import classNames from "classnames";
import { ClientOnly } from "remix-utils";

Prism.manual = true;

type CodeBlockProps = {
  code: string;
  language?: string;
};

export default function CodeBlock({
  code,
  language = "typescript",
}: CodeBlockProps) {
  return (
    <ClientOnly fallback={<pre>{code}</pre>}>
      {() => <CodeBlockWithColoring code={code} language={language} />}
    </ClientOnly>
  );
}

function CodeBlockWithColoring({
  code,
  language = "typescript",
}: CodeBlockProps) {
  useEffect(() => {
    Prism.highlightAll();
  }, []);
  return (
    <pre className={classNames("flex rounded-md", `language-${language}`)}>
      <code className={`language-${language}`}>{code}</code>
    </pre>
  );
}

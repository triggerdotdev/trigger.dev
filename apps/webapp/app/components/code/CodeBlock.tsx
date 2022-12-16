import { useEffect } from "react";
import Prism from "prismjs";

type CodeBlockProps = {
  code: string;
  language?: string;
};

export default function CodeBlock({
  code,
  language = "typescript",
}: CodeBlockProps) {
  useEffect(() => {
    Prism.highlightAll();
  }, []);

  return (
    <pre className="flex rounded-md">
      <code className={`language-${language}`}>{code}</code>
    </pre>
  );
}

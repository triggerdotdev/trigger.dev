import { useEffect } from "react";
import Prism from "prismjs";

type CodeBlockProps = {
  code: string;
  language: string;
};

export default function CodeBlock({ code, language }: CodeBlockProps) {
  useEffect(() => {
    Prism.highlightAll();
  }, []);

  return (
    <pre className="flex">
      <code className={`language-${language}`}>{code}</code>
    </pre>
  );
}

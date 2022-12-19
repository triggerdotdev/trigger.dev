import { useEffect, useState } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-json";

Prism.manual = true;

type CodeBlockProps = {
  code: string;
  language?: "typescript" | "json";
};

export default function CodeBlock({
  code,
  language = "typescript",
}: CodeBlockProps) {
  const [codeHtml, setCodeHtml] = useState(code);
  useEffect(() => {
    const val = Prism.highlight(code, Prism.languages[language], language);
    setCodeHtml(val);
  }, [code, language]);

  return (
    <pre className={`flex rounded-md language-${language}`}>
      <code
        className={`language-${language}`}
        dangerouslySetInnerHTML={{ __html: codeHtml }}
      ></code>
    </pre>
  );
}

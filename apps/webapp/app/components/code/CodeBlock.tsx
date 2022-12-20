import { useEffect, useState } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-json";
import { CopyTextButton } from "../CopyTextButton";
import classNames from "classnames";

Prism.manual = true;

type CodeBlockProps = {
  code: string;
  language?: "typescript" | "json";
  showCopyButton?: boolean;
  align?: "top" | "center";
  className?: string;
};

export default function CodeBlock({
  code,
  language = "typescript",
  showCopyButton = true,
  align = "center",
  className,
}: CodeBlockProps) {
  const [codeHtml, setCodeHtml] = useState(code);
  useEffect(() => {
    const val = Prism.highlight(code, Prism.languages[language], language);
    setCodeHtml(val);
  }, [code, language]);

  return (
    <div
      className={classNames(
        "flex rounded-md bg-[#0F172A] pl-2",
        className,
        align === "center" ? "items-center" : "items-start"
      )}
    >
      <pre className={`flex-grow language-${language}`}>
        <code
          className={`language-${language}`}
          dangerouslySetInnerHTML={{ __html: codeHtml }}
        ></code>
      </pre>
      {showCopyButton === true && (
        <CopyTextButton
          className="text-sm my-2 mx-3"
          value={code}
          variant="slate"
        />
      )}
    </div>
  );
}

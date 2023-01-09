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
  maxHeight?: string;
  className?: string;
};

export default function CodeBlock({
  code,
  language = "typescript",
  showCopyButton = true,
  align = "center",
  maxHeight,
  className,
}: CodeBlockProps) {
  const [codeHtml, setCodeHtml] = useState(code);
  const [isCollapsed, setIsCollapsed] = useState(
    maxHeight === undefined ? false : true
  );
  useEffect(() => {
    const val = Prism.highlight(code, Prism.languages[language], language);
    setCodeHtml(val);
  }, [code, language]);

  return (
    <div
      className={classNames(
        "relative rounded-md bg-[#0F172A] pl-2",
        className,
        isCollapsed ? "overflow-hidden" : ""
      )}
      style={{ maxHeight: isCollapsed ? maxHeight : undefined }}
    >
      <pre className={`language-${language}`}>
        <code
          className={`language-${language}`}
          dangerouslySetInnerHTML={{ __html: codeHtml }}
        ></code>
      </pre>
      {showCopyButton === true && (
        <CopyTextButton
          className={classNames(
            "absolute text-sm my-2 mx-2",
            align === "center" ? " top-1/2 right-0" : "top-0 right-0"
          )}
          value={code}
          variant="slate"
        />
      )}
      {maxHeight && (
        <div className="absolute left-0 bottom-0 w-full flex items-center justify-center bg-gradient-to-b from-transparent to-[#0F172A]">
          <button
            className="bg-slate-800 rounded-full py-2 px-3.5 text-xs mb-1 hover:bg-slate-700 transition"
            onClick={(e) => setIsCollapsed((s) => !s)}
          >
            {isCollapsed ? "Expand" : "Collapse"}
          </button>
        </div>
      )}
    </div>
  );
}

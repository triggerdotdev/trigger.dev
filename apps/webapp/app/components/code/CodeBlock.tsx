import { useState } from "react";
import type { PrismProps } from "@mantine/prism";
import { Prism } from "@mantine/prism";
import { theme } from "./prismTheme";
import { cn } from "~/utils/cn";

type CodeBlockProps = {
  code: string;
  language?: PrismProps["language"];
  showCopyButton?: boolean;
  showLineNumbers?: boolean;
  className?: string;
  highlightLines?: number[];
};

const highlighted: NonNullable<PrismProps["highlightLines"]>[string] = {
  color: "grape",
};

export default function CodeBlock({
  code,
  language = "typescript",
  showCopyButton = true,
  showLineNumbers = true,
  className,
  highlightLines = [],
}: CodeBlockProps) {
  let highlightedLines: PrismProps["highlightLines"] = {};

  if (highlightLines) {
    highlightedLines = highlightLines.reduce((acc, line) => {
      acc[line] = highlighted;
      return acc;
    }, {} as Record<number, { color: string; label?: string }>);
  }

  return (
    <Prism
      className={cn("rounded-md border border-slate-800", className)}
      language={language}
      withLineNumbers={showLineNumbers}
      getPrismTheme={() => theme}
      noCopy={!showCopyButton}
      copyLabel="Copy code"
      copiedLabel="Code copied"
      radius="md"
      highlightLines={highlightedLines}
    >
      {code}
    </Prism>
  );
}

//   return (
//     <div
//       className={classNames(
//         "relative rounded-md bg-[#0F172A] pl-2",
//         className,
//         isCollapsed ? "overflow-hidden" : ""
//       )}
//       style={{ maxHeight: isCollapsed ? maxHeight : undefined }}
//     >
//       <pre
//         className={classNames(showLineNumbers && `line-numbers`)}
//         ref={codeRef}
//       >
//         <code className={`language-${language}`}>{code}</code>
//       </pre>
//       {showCopyButton === true && (
//         <CopyTextButton
//           className={classNames(
//             "absolute my-2 mx-2 text-sm",
//             align === "center" ? " top-1/2 right-0" : "top-0 right-0"
//           )}
//           value={code}
//           variant="slate"
//         />
//       )}
//       {maxHeight && (
//         <div className="absolute left-0 bottom-0 flex w-full items-center justify-center bg-gradient-to-b from-transparent to-[#0F172A]">
//           <button
//             className="mb-1 rounded-full bg-slate-800 py-2 px-3.5 text-xs transition hover:bg-slate-700"
//             onClick={(e) => setIsCollapsed((s) => !s)}
//           >
//             {isCollapsed ? "Expand" : "Collapse"}
//           </button>
//         </div>
//       )}
//     </div>
//   );
// }

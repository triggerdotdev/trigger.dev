import type { Language, PrismTheme } from "prism-react-renderer";
import Highlight, { defaultProps } from "prism-react-renderer";
import { forwardRef, useCallback, useState } from "react";
import { cn } from "~/utils/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../primitives/Tooltip";
import {
  ClipboardDocumentCheckIcon,
  ClipboardIcon,
} from "@heroicons/react/24/solid";
import { Clipboard, ClipboardCheck, ClipboardCheckIcon } from "lucide-react";

//This is a fork of https://github.com/mantinedev/mantine/blob/master/src/mantine-prism/src/Prism/Prism.tsx
//it didn't support highlighting lines by dimming the rest of the code, or animations on the highlighting

type CodeBlockProps = {
  /** Code which will be highlighted */
  code: string;

  /** Programming language that should be highlighted */
  language?: Language;

  /** Show copy to clipboard button */
  showCopyButton?: boolean;

  /** Display line numbers */
  showLineNumbers?: boolean;

  /** Highlight line at given line number with color from theme.colors */
  highlightedRanges?: [number, number][];

  /** Add/override classes on the overall element */
  className?: string;

  /** Add/override code theme */
  theme?: PrismTheme;

  /** Max lines */
  maxLines?: number;

  /** Whether to show the chrome, if you provide a string it will be used as the title, */
  showChrome?: boolean;

  /** filename */
  fileName?: string;
};

const dimAmount = 0.5;
const extraLinesWhenClipping = 0.35;

const defaultTheme: PrismTheme = {
  plain: {
    color: "#9CDCFE",
    backgroundColor: "#0e1521",
  },
  styles: [
    {
      types: ["prolog"],
      style: {
        color: "rgb(0, 0, 128)",
      },
    },
    {
      types: ["comment"],
      style: {
        color: "rgb(106, 153, 85)",
      },
    },
    {
      types: ["builtin", "changed", "keyword", "interpolation-punctuation"],
      style: {
        color: "rgb(86, 156, 214)",
      },
    },
    {
      types: ["number", "inserted"],
      style: {
        color: "rgb(181, 206, 168)",
      },
    },
    {
      types: ["constant"],
      style: {
        color: "rgb(100, 102, 149)",
      },
    },
    {
      types: ["attr-name", "variable"],
      style: {
        color: "rgb(156, 220, 254)",
      },
    },
    {
      types: ["deleted", "string", "attr-value", "template-punctuation"],
      style: {
        color: "rgb(206, 145, 120)",
      },
    },
    {
      types: ["selector"],
      style: {
        color: "rgb(215, 186, 125)",
      },
    },
    {
      // Fix tag color
      types: ["tag"],
      style: {
        color: "rgb(78, 201, 176)",
      },
    },
    {
      // Fix tag color for HTML
      types: ["tag"],
      languages: ["markup"],
      style: {
        color: "rgb(86, 156, 214)",
      },
    },
    {
      types: ["punctuation", "operator"],
      style: {
        color: "rgb(212, 212, 212)",
      },
    },
    {
      // Fix punctuation color for HTML
      types: ["punctuation"],
      languages: ["markup"],
      style: {
        color: "#808080",
      },
    },
    {
      types: ["function"],
      style: {
        color: "rgb(220, 220, 170)",
      },
    },
    {
      types: ["class-name"],
      style: {
        color: "rgb(78, 201, 176)",
      },
    },
    {
      types: ["char"],
      style: {
        color: "rgb(209, 105, 105)",
      },
    },
  ],
};

export const CodeBlock = forwardRef<HTMLDivElement, CodeBlockProps>(
  (
    {
      showCopyButton = true,
      showLineNumbers = true,
      highlightedRanges,
      code,
      className,
      language = "typescript",
      theme = defaultTheme,
      maxLines,
      showChrome = false,
      fileName,
      ...props
    }: CodeBlockProps,
    ref
  ) => {
    const [mouseOver, setMouseOver] = useState(false);
    const [copied, setCopied] = useState(false);
    const onCopied = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1500);
      },
      [code]
    );

    code = code.trim();
    const lineCount = code.split("\n").length;
    const maxLineWidth = lineCount.toString().length;
    let maxHeight: string | undefined = undefined;
    if (maxLines && lineCount > maxLines) {
      maxHeight = `calc(${
        (maxLines + extraLinesWhenClipping) * 0.75 * 1.625
      }rem + 1.5rem )`;
    }

    const highlightLines = highlightedRanges?.flatMap(([start, end]) =>
      Array.from({ length: end - start + 1 }, (_, i) => start + i)
    );

    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-md border border-slate-800",
          className
        )}
        style={{
          backgroundColor: theme.plain.backgroundColor,
        }}
        ref={ref}
        {...props}
        translate="no"
      >
        {showChrome && <Chrome title={fileName} />}
        {showCopyButton && (
          <TooltipProvider>
            <Tooltip open={copied || mouseOver}>
              <TooltipTrigger
                onClick={onCopied}
                onMouseEnter={() => setMouseOver(true)}
                onMouseLeave={() => setMouseOver(false)}
                className={cn(
                  "absolute  right-3 z-50 transition-colors duration-100 hover:cursor-pointer",
                  showChrome ? "top-10" : "top-3",
                  copied
                    ? "text-emerald-500"
                    : "text-slate-500 hover:text-slate-300"
                )}
              >
                {copied ? (
                  <ClipboardCheck className="h-5 w-5" />
                ) : (
                  <Clipboard className="h-5 w-5" />
                )}
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                {copied ? "Copied" : "Copy"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        <Highlight
          {...defaultProps}
          theme={theme}
          code={code}
          language={language}
        >
          {({
            className: inheritedClassName,
            style: inheritedStyle,
            tokens,
            getLineProps,
            getTokenProps,
          }) => (
            <div
              dir="ltr"
              className="overflow-auto px-2 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
              style={{
                maxHeight,
              }}
            >
              <pre
                className={cn(
                  "relative mr-2 font-mono text-xs leading-relaxed",
                  inheritedClassName
                )}
                style={inheritedStyle}
                dir="ltr"
              >
                {tokens
                  .map((line, index) => {
                    if (
                      index === tokens.length - 1 &&
                      line.length === 1 &&
                      line[0].content === "\n"
                    ) {
                      return null;
                    }

                    const lineNumber = index + 1;
                    const lineProps = getLineProps({ line, key: index });

                    let hasAnyHighlights = highlightLines
                      ? highlightLines.length > 0
                      : false;

                    let shouldDim = hasAnyHighlights;
                    if (
                      hasAnyHighlights &&
                      highlightLines?.includes(lineNumber)
                    ) {
                      shouldDim = false;
                    }

                    return (
                      <div
                        key={lineProps.key}
                        {...lineProps}
                        className={cn(
                          "flex w-full justify-start transition-opacity duration-500",
                          lineProps.className
                        )}
                        style={{
                          opacity: shouldDim ? dimAmount : undefined,
                          ...lineProps.style,
                        }}
                      >
                        {showLineNumbers && (
                          <div
                            className={
                              "mr-2 flex-none select-none text-right text-slate-500 transition-opacity duration-500"
                            }
                            style={{
                              width: `calc(8 * ${maxLineWidth / 16}rem)`,
                            }}
                          >
                            {lineNumber}
                          </div>
                        )}

                        <div className="flex-1">
                          {line.map((token, key) => {
                            const tokenProps = getTokenProps({ token, key });
                            return (
                              <span
                                key={tokenProps.key}
                                {...tokenProps}
                                style={{
                                  color: tokenProps?.style?.color as string,
                                  ...tokenProps.style,
                                }}
                              />
                            );
                          })}
                        </div>
                        <div className="w-4 flex-none" />
                      </div>
                    );
                  })
                  .filter(Boolean)}
              </pre>
            </div>
          )}
        </Highlight>
      </div>
    );
  }
);

CodeBlock.displayName = "CodeBlock";

function Chrome({ title }: { title?: string }) {
  return (
    <div className="grid h-7 grid-cols-[100px_auto_100px] border-b border-slate-800 bg-slate-900">
      <div className="ml-2 flex items-center gap-2">
        <div className="h-3 w-3 rounded-full bg-slate-700" />
        <div className="h-3 w-3 rounded-full bg-slate-700" />
        <div className="h-3 w-3 rounded-full bg-slate-700" />
      </div>
      <div className="flex items-center justify-center">
        <div
          className={cn(
            "rounded-sm px-3 py-0.5 text-xs text-slate-500",
            title && "bg-midnight-900"
          )}
        >
          {title}
        </div>
      </div>
      <div></div>
    </div>
  );
}

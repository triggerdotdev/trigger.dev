import { ClipboardIcon } from "@heroicons/react/20/solid";
import type { Language, PrismTheme } from "prism-react-renderer";
import Highlight, { defaultProps } from "prism-react-renderer";
import { forwardRef } from "react";
import { cn } from "~/utils/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../primitives/Tooltip";

//This is a fork of https://github.com/mantinedev/mantine/blob/master/src/mantine-prism/src/Prism/Prism.tsx
//it didn't support highlighting lines by dimming the rest of the code, or animations on the highlighting

type CodeBlockProps = {
  /** Code which will be highlighted */
  code: string;
  /** Programming language that should be highlighted */
  language: Language;

  /** Show copy to clipboard button */
  showCopyButton?: boolean;

  /** Display line numbers */
  showLineNumbers?: boolean;

  /** Highlight line at given line number with color from theme.colors */
  highlightLines?: number[];

  /** Add/override classes on the overall element */
  className?: string;

  /** Add/override code theme */
  theme?: PrismTheme;
};

const dimAmount = 0.5;

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
      highlightLines,
      code,
      className,
      language,
      theme = defaultTheme,
      ...props
    }: CodeBlockProps,
    ref
  ) => {
    code = code.trim();
    const maxLineSize = code.split("\n").length.toString().length;

    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-md border border-slate-800 ",
          className
        )}
        style={{ backgroundColor: theme.plain.backgroundColor }}
        ref={ref}
        {...props}
        translate="no"
      >
        {showCopyButton && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger className="absolute top-1 right-1 z-50">
                <ClipboardIcon className="h-5 w-4 text-slate-500" />
              </TooltipTrigger>
              <TooltipContent>Copy</TooltipContent>
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
              className="overflow-auto py-1 px-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700"
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
                              width: `calc(8 * ${maxLineSize / 16}rem)`,
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

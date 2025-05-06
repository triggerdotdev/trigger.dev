import { ArrowsPointingOutIcon } from "@heroicons/react/20/solid";
import { Clipboard, ClipboardCheck } from "lucide-react";
import type { Language, PrismTheme } from "prism-react-renderer";
import { Highlight, Prism } from "prism-react-renderer";
import { forwardRef, ReactNode, useCallback, useEffect, useState } from "react";
import { TextWrapIcon } from "~/assets/icons/TextWrapIcon";
import { cn } from "~/utils/cn";
import { Button } from "../primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../primitives/Dialog";
import { Paragraph } from "../primitives/Paragraph";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../primitives/Tooltip";
import { TextInlineIcon } from "~/assets/icons/TextInlineIcon";

//This is a fork of https://github.com/mantinedev/mantine/blob/master/src/mantine-prism/src/Prism/Prism.tsx
//it didn't support highlighting lines by dimming the rest of the code, or animations on the highlighting

async function setup() {
  (typeof global !== "undefined" ? global : window).Prism = Prism;
  //@ts-ignore
  await import("prismjs/components/prism-json");
  //@ts-ignore
  await import("prismjs/components/prism-typescript");
}
setup();

type CodeBlockProps = {
  /** Code which will be highlighted */
  code: string;

  /** Programming language that should be highlighted */
  language?: Language;

  /** Show copy to clipboard button */
  showCopyButton?: boolean;

  /** Show text wrapping button */
  showTextWrapping?: boolean;

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

  /** title text for the Title row */
  rowTitle?: ReactNode;

  /** Whether to show the open in modal button */
  showOpenInModal?: boolean;
};

const dimAmount = 0.5;
const extraLinesWhenClipping = 0.35;

const defaultTheme: PrismTheme = {
  plain: {
    color: "#9C9AF2",
    backgroundColor: "rgba(0, 0, 0, 0)",
  },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: {
        color: "#5F6570",
      },
    },
    {
      types: ["punctuation"],
      style: {
        color: "#878C99",
      },
    },
    {
      types: ["property", "tag", "boolean", "number", "constant", "symbol", "deleted"],
      style: {
        color: "#9B99FF",
      },
    },
    {
      types: ["selector", "attr-name", "string", "char", "builtin", "inserted"],
      style: {
        color: "#AFEC73",
      },
    },
    {
      types: ["operator", "entity", "url"],
      style: {
        color: "#D4D4D4",
      },
    },
    {
      types: ["variable"],
      style: {
        color: "#CCCBFF",
      },
    },
    {
      types: ["atrule", "attr-value", "keyword"],
      style: {
        color: "#E888F8",
      },
    },
    {
      types: ["function", "class-name"],
      style: {
        color: "#D9F07C",
      },
    },
    {
      types: ["regex"],
      style: {
        color: "#d16969",
      },
    },
    {
      types: ["important", "bold"],
      style: {
        fontWeight: "bold",
      },
    },
    {
      types: ["italic"],
      style: {
        fontStyle: "italic",
      },
    },
    {
      types: ["namespace"],
      style: {
        opacity: 0.7,
      },
    },
    {
      types: ["deleted"],
      style: {
        color: "#F85149",
      },
    },
    {
      types: ["boolean"],
      style: {
        color: "#9B99FF",
      },
    },
    {
      types: ["char"],
      style: {
        color: "#b5cea8",
      },
    },
    {
      types: ["tag"],
      style: {
        color: "#D7BA7D",
      },
    },
    {
      types: ["keyword.operator"],
      style: {
        color: "#8271ED",
      },
    },
    {
      types: ["meta.template.expression"],
      style: {
        color: "#d4d4d4",
      },
    },
  ],
};

export const CodeBlock = forwardRef<HTMLDivElement, CodeBlockProps>(
  (
    {
      showCopyButton = true,
      showTextWrapping = false,
      showLineNumbers = true,
      showOpenInModal = true,
      highlightedRanges,
      code,
      className,
      language = "typescript",
      theme = defaultTheme,
      maxLines,
      showChrome = false,
      fileName,
      rowTitle,
      ...props
    }: CodeBlockProps,
    ref
  ) => {
    const [mouseOver, setMouseOver] = useState(false);
    const [copied, setCopied] = useState(false);
    const [modalCopied, setModalCopied] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isWrapped, setIsWrapped] = useState(false);

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

    const onModalCopied = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        navigator.clipboard.writeText(code);
        setModalCopied(true);
        setTimeout(() => {
          setModalCopied(false);
        }, 1500);
      },
      [code]
    );

    code = code.trim();
    const lineCount = code.split("\n").length;
    const maxLineWidth = lineCount.toString().length;
    let maxHeight: string | undefined = undefined;
    if (maxLines && lineCount > maxLines) {
      maxHeight = `calc(${(maxLines + extraLinesWhenClipping) * 0.75 * 1.625}rem + 1.5rem )`;
    }

    const highlightLines = highlightedRanges?.flatMap(([start, end]) =>
      Array.from({ length: end - start + 1 }, (_, i) => start + i)
    );

    // if there are more than 1000 lines, don't highlight
    const shouldHighlight = lineCount <= 1000;

    return (
      <>
        <div
          className={cn("relative overflow-hidden rounded-md border border-grid-bright", className)}
          style={{
            backgroundColor: theme.plain.backgroundColor,
          }}
          ref={ref}
          {...props}
          translate="no"
        >
          {showChrome && <Chrome title={fileName} />}
          {rowTitle && <TitleRow title={rowTitle} />}
          <div
            className={cn(
              "absolute right-3 top-2.5 z-50 flex gap-3",
              showChrome ? "right-1.5 top-1.5" : "top-2.5"
            )}
          >
            {showTextWrapping && (
              <TooltipProvider>
                <Tooltip disableHoverableContent>
                  <TooltipTrigger
                    onClick={() => setIsWrapped(!isWrapped)}
                    className="transition-colors focus-custom hover:cursor-pointer hover:text-text-bright"
                  >
                    {isWrapped ? (
                      <TextInlineIcon className="size-4" />
                    ) : (
                      <TextWrapIcon className="size-4" />
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    {isWrapped ? "Unwrap" : "Wrap"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {showCopyButton && (
              <TooltipProvider>
                <Tooltip open={copied || mouseOver} disableHoverableContent>
                  <TooltipTrigger
                    onClick={onCopied}
                    onMouseEnter={() => setMouseOver(true)}
                    onMouseLeave={() => setMouseOver(false)}
                    className={cn(
                      "transition-colors duration-100 focus-custom hover:cursor-pointer",
                      copied ? "text-success" : "text-text-dimmed hover:text-text-bright"
                    )}
                  >
                    {copied ? (
                      <ClipboardCheck className="size-4" />
                    ) : (
                      <Clipboard className="size-4" />
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    {copied ? "Copied" : "Copy"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {showOpenInModal && (
              <TooltipProvider>
                <Tooltip disableHoverableContent>
                  <TooltipTrigger onClick={() => setIsModalOpen(true)}>
                    <ArrowsPointingOutIcon className="size-4 transition-colors hover:text-text-bright" />
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    Expand
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {shouldHighlight ? (
            <HighlightCode
              theme={theme}
              code={code}
              language={language}
              showLineNumbers={showLineNumbers}
              highlightLines={highlightLines}
              maxLineWidth={maxLineWidth}
              className="px-2 py-3"
              preClassName="text-xs"
              isWrapped={isWrapped}
            />
          ) : (
            <div
              dir="ltr"
              className={cn(
                "px-2 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600",
                !isWrapped && "overflow-x-auto",
                isWrapped && "overflow-y-auto"
              )}
              style={{
                maxHeight,
              }}
            >
              <pre
                className={cn(
                  "relative mr-2 p-2 font-mono text-xs leading-relaxed",
                  isWrapped && "[&_span]:whitespace-pre-wrap [&_span]:break-words"
                )}
                dir="ltr"
              >
                {code}
              </pre>
            </div>
          )}
        </div>

        <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
          <DialogContent className="flex flex-col gap-0 p-0 pt-[2.9rem] sm:h-[80vh] sm:max-h-[80vh] sm:max-w-[80vw]">
            <DialogHeader className="h-fit">
              <DialogTitle className="absolute left-3.5 top-2.5">
                {fileName && fileName}
                {rowTitle && rowTitle}
              </DialogTitle>
              <Button
                variant="tertiary/small"
                onClick={onModalCopied}
                className="absolute right-4 top-16 z-50"
                LeadingIcon={modalCopied ? undefined : Clipboard}
                leadingIconClassName="size-3 -ml-1"
              >
                {modalCopied ? "Copied" : "Copy"}
              </Button>
            </DialogHeader>

            {shouldHighlight ? (
              <HighlightCode
                theme={theme}
                code={code}
                language={language}
                showLineNumbers={showLineNumbers}
                highlightLines={highlightLines}
                maxLineWidth={maxLineWidth}
                className="min-h-full"
                preClassName="text-sm"
                isWrapped={isWrapped}
              />
            ) : (
              <div
                dir="ltr"
                className="overflow-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
              >
                <pre className="relative mr-2 p-2 font-mono text-base leading-relaxed" dir="ltr">
                  {code}
                </pre>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </>
    );
  }
);

CodeBlock.displayName = "CodeBlock";

function Chrome({ title }: { title?: string }) {
  return (
    <div className="grid h-7 grid-cols-[100px_auto_100px] border-b border-charcoal-800 bg-charcoal-900">
      <div className="ml-2 flex items-center gap-2">
        <div className="h-3 w-3 rounded-full bg-charcoal-700" />
        <div className="h-3 w-3 rounded-full bg-charcoal-700" />
        <div className="h-3 w-3 rounded-full bg-charcoal-700" />
      </div>
      <div className="flex items-center justify-center">
        <div className={cn("rounded-sm px-3 py-0.5 text-xs text-charcoal-500")}>{title}</div>
      </div>
      <div></div>
    </div>
  );
}

export function TitleRow({ title }: { title: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3">
      <Paragraph variant="small/bright" className="w-full border-b border-grid-dimmed py-2">
        {title}
      </Paragraph>
    </div>
  );
}

type HighlightCodeProps = {
  theme: PrismTheme;
  code: string;
  language: Language;
  showLineNumbers: boolean;
  highlightLines?: number[];
  maxLineWidth?: number;
  className?: string;
  preClassName?: string;
  isWrapped: boolean;
};

function HighlightCode({
  theme,
  code,
  language,
  showLineNumbers,
  highlightLines,
  maxLineWidth,
  className,
  preClassName,
  isWrapped,
}: HighlightCodeProps) {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      //@ts-ignore
      import("prismjs/components/prism-json"),
      //@ts-ignore
      import("prismjs/components/prism-typescript"),
    ]).then(() => setIsLoaded(true));
  }, []);

  const containerClasses = cn(
    "px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600",
    !isWrapped && "overflow-x-auto",
    isWrapped && "overflow-y-auto",
    className
  );

  const preClasses = cn(
    "relative mr-2 font-mono leading-relaxed",
    preClassName,
    isWrapped && "[&_span]:whitespace-pre-wrap [&_span]:break-words"
  );

  if (!isLoaded) {
    return (
      <div dir="ltr" className={containerClasses}>
        <pre className={preClasses}>{code}</pre>
      </div>
    );
  }

  return (
    <Highlight theme={theme} code={code} language={language}>
      {({
        className: inheritedClassName,
        style: inheritedStyle,
        tokens,
        getLineProps,
        getTokenProps,
      }) => (
        <div dir="ltr" className={containerClasses}>
          <pre className={cn(preClasses, inheritedClassName)} style={inheritedStyle} dir="ltr">
            {tokens
              .map((line, index) => {
                if (index === tokens.length - 1 && line.length === 1 && line[0].content === "\n") {
                  return null;
                }

                const lineNumber = index + 1;
                const lineProps = getLineProps({ line, key: index });

                let hasAnyHighlights = highlightLines ? highlightLines.length > 0 : false;

                let shouldDim = hasAnyHighlights;
                if (hasAnyHighlights && highlightLines?.includes(lineNumber)) {
                  shouldDim = false;
                }

                return (
                  <div
                    key={lineNumber}
                    {...lineProps}
                    className={cn(
                      "flex w-full justify-start transition-opacity duration-500",
                      lineProps.className,
                      isWrapped && "flex-wrap"
                    )}
                    style={{
                      opacity: shouldDim ? dimAmount : undefined,
                      ...lineProps.style,
                    }}
                  >
                    {showLineNumbers && (
                      <div
                        className={cn(
                          "mr-2 flex-none select-none text-right text-charcoal-500 transition-opacity duration-500",
                          isWrapped && "sticky left-0"
                        )}
                        style={{
                          width: `calc(8 * ${(maxLineWidth as number) / 16}rem)`,
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
                            key={key}
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
  );
}

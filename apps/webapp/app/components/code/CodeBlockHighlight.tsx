import { Highlight, Prism } from "prism-react-renderer";
import type { Language, PrismTheme } from "prism-react-renderer";
import { cn } from "~/utils/cn";
import { highlightSearchText } from "~/utils/logUtils";

// The syntax highlighter for CodeBlock. It loads after the page is interactive; until then
// CodeBlock shows the same code unhighlighted.

async function setup() {
  (typeof global !== "undefined" ? global : window).Prism = Prism;
  //@ts-ignore
  await import("prismjs/components/prism-json");
  //@ts-ignore
  await import("prismjs/components/prism-typescript");
  //@ts-ignore
  await import("prismjs/components/prism-sql.js");
}

export const prismReady = setup();

const dimAmount = 0.5;

export type HighlightedCodeProps = {
  theme: PrismTheme;
  code: string;
  language: Language;
  showLineNumbers: boolean;
  highlightLines?: number[];
  maxLineWidth?: number;
  isWrapped: boolean;
  searchTerm?: string;
  containerClasses: string;
  preClasses: string;
};

export function HighlightedCode({
  theme,
  code,
  language,
  showLineNumbers,
  highlightLines,
  maxLineWidth,
  isWrapped,
  searchTerm,
  containerClasses,
  preClasses,
}: HighlightedCodeProps) {
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
                const lineProps = getLineProps({ line });

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
                          "mr-2 flex-none select-none text-right text-text-faint transition-opacity duration-500",
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
                        const tokenProps = getTokenProps({ token });

                        // Highlight search term matches in token
                        const content = highlightSearchText(token.content, searchTerm);

                        return (
                          <span
                            key={key}
                            {...tokenProps}
                            style={{
                              color: tokenProps?.style?.color as string,
                              ...tokenProps.style,
                            }}
                          >
                            {content}
                          </span>
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

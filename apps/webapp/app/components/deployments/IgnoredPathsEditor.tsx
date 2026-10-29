import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { RangeSet } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutterLineClass,
  placeholder,
  type ViewUpdate,
} from "@codemirror/view";
import { ExclamationCircleIcon } from "@heroicons/react/20/solid";
import { ChevronDownIcon, ChevronUpIcon, FlaskConicalIcon } from "lucide-react";
import picomatch from "picomatch/posix.js";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { TextEditor } from "~/components/code/TextEditor";
import { Button } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";
import { ignorePathError, type IgnorePathLimits } from "~/v3/github";

const FOLDED_LINES = 3;
const MAX_VISIBLE_LINES = 15;
// CodeMirror's line height and vertical padding in the editor theme, used until it is measured.
const ESTIMATED_LINE_HEIGHT = 18.2;
const ESTIMATED_PADDING = 8;

const MATCH_CLASS = "cm-ignored-match";
class MatchedLineMarker extends GutterMarker {
  elementClass = MATCH_CLASS;
}
const matchedLineMarker = new MatchedLineMarker();
const matchedLine = Decoration.line({ class: MATCH_CLASS });

const editorExtensions = [
  lintGutter(),
  placeholder("docs/**"),
  EditorView.theme({
    "&.cm-focused": { outline: "none" },
    ".cm-line": { transition: "background-color 150ms ease-out" },
    [`.cm-line.${MATCH_CLASS}`]: {
      backgroundColor: "color-mix(in srgb, var(--color-indigo-500) 16%, transparent)",
    },
    [`.cm-gutterElement.${MATCH_CLASS}`]: { color: "var(--color-indigo-400)" },
  }),
];

type Line = { pattern: string; start: number; error?: string; valid: boolean };
type Heights = { content: number; folded: number; max: number };

function analyze(text: string, { maxPaths, maxLength }: IgnorePathLimits) {
  let start = 0;
  const lines: Line[] = text.split("\n").map((line) => {
    const pattern = line.trim();
    const error = pattern ? ignorePathError(pattern, maxLength) : undefined;
    const parsed = { pattern, start, error, valid: pattern !== "" && !error };
    start += line.length + 1;
    return parsed;
  });
  const patterns = lines.flatMap(({ pattern }) => (pattern ? [pattern] : []));
  const errors = [
    ...lines.flatMap(({ error }, index) => (error ? [`Line ${index + 1}: ${error}`] : [])),
    ...(patterns.length > maxPaths ? [`Add at most ${maxPaths} paths.`] : []),
  ];
  return { lines, patterns, errors };
}

function lintPaths(limits: IgnorePathLimits) {
  return (view: EditorView): Diagnostic[] =>
    analyze(view.state.doc.toString(), limits).lines.flatMap(({ error }, index) => {
      if (!error) return [];
      const line = view.state.doc.line(index + 1);
      return [{ from: line.from, to: line.to, severity: "error", message: error }];
    });
}

function measure(view: EditorView): Heights {
  const { top, bottom } = view.documentPadding;
  const { doc } = view.state;
  return {
    content: view.contentHeight,
    folded: top + view.lineBlockAt(doc.line(Math.min(FOLDED_LINES, doc.lines)).from).bottom,
    max: top + bottom + MAX_VISIBLE_LINES * view.defaultLineHeight,
  };
}

const verdictTones = {
  Ignored: "bg-indigo-500/15 text-indigo-400 light:text-indigo-700",
  Deploys: "bg-success/15 text-success",
};

function VerdictBadge({ verdict }: { verdict: keyof typeof verdictTones }) {
  return (
    <span
      className={cn(
        "flex-none rounded-sm px-1.5 py-0.5 duration-150 animate-in fade-in zoom-in-95",
        verdictTones[verdict]
      )}
    >
      {verdict}
    </span>
  );
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function IgnoredPathsEditor({
  name,
  defaultPatterns,
  limits,
  onChange,
}: {
  name: string;
  defaultPatterns: string[];
  limits: IgnorePathLimits;
  onChange?: (patterns: string[], valid: boolean) => void;
}) {
  // TextEditor replaces the document whenever defaultValue changes.
  const [defaultText] = useState(() => defaultPatterns.join("\n"));
  const [text, setText] = useState(defaultText);
  const [folded, setFolded] = useState(defaultPatterns.length > FOLDED_LINES);
  const [heights, setHeights] = useState<Heights>();
  const [animating, setAnimating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testPath, setTestPath] = useState("");
  const viewRef = useRef<EditorView>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const testButtonRef = useRef<HTMLButtonElement>(null);
  const errorsId = useId();

  const { maxPaths, maxLength } = limits;
  const { lines, patterns, errors } = useMemo(
    () => analyze(text, { maxPaths, maxLength }),
    [text, maxPaths, maxLength]
  );
  const path = testPath.trim();
  const matchedIndex =
    testing && path
      ? lines.findIndex(({ pattern, valid }) => valid && picomatch(pattern, { dot: true })(path))
      : -1;
  const canTest = lines.some(({ valid }) => valid);
  const canFold = lines.length > FOLDED_LINES;
  const isFolded = folded && canFold;
  const foldedRef = useRef(isFolded);
  useEffect(() => {
    foldedRef.current = isFolded;
  }, [isFolded]);
  const visibleHeight = heights
    ? isFolded
      ? heights.folded
      : Math.min(heights.content, heights.max)
    : (isFolded ? FOLDED_LINES : Math.min(lines.length, MAX_VISIBLE_LINES)) *
        ESTIMATED_LINE_HEIGHT +
      ESTIMATED_PADDING;
  const Chevron = isFolded ? ChevronDownIcon : ChevronUpIcon;
  const verdict = matchedIndex >= 0 ? "Ignored" : "Deploys";
  const invalid = errors.length > 0;
  const matchedStart = matchedIndex >= 0 ? lines[matchedIndex].start : undefined;

  // TextEditor reconfigures CodeMirror whenever the extensions or callbacks change identity.
  const extensions = useMemo(
    () => [
      ...editorExtensions,
      linter(lintPaths({ maxPaths, maxLength }), { delay: 100 }),
      EditorView.contentAttributes.of({
        "aria-label": "Ignored paths",
        "aria-invalid": String(invalid),
        ...(invalid ? { "aria-describedby": errorsId } : {}),
      }),
      ...(matchedStart !== undefined
        ? [
            EditorView.decorations.of(Decoration.set(matchedLine.range(matchedStart))),
            gutterLineClass.of(RangeSet.of(matchedLineMarker.range(matchedStart))),
          ]
        : []),
    ],
    [maxPaths, maxLength, invalid, errorsId, matchedStart]
  );

  const edit = useCallback(
    (next: string) => {
      setText(next);
      const { patterns, errors } = analyze(next, limits);
      onChange?.(patterns, errors.length === 0);
    },
    [limits, onChange]
  );

  const onUpdate = useCallback((update: ViewUpdate) => {
    if (update.focusChanged && update.view.hasFocus && foldedRef.current) {
      setAnimating(true);
      setFolded(false);
    }
    if (update.geometryChanged || update.heightChanged || update.docChanged) {
      const next = measure(update.view);
      setHeights((prev) =>
        prev?.content === next.content && prev.folded === next.folded && prev.max === next.max
          ? prev
          : next
      );
    }
  }, []);

  const toggleFold = () => {
    setAnimating(true);
    if (isFolded) {
      setFolded(false);
      viewRef.current?.focus();
    } else {
      setFolded(true);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
  };

  const closeTester = () => {
    setTesting(false);
    setTestPath("");
    testButtonRef.current?.focus();
  };

  const onTesterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter would submit the settings form.
    if (event.key === "Enter") event.preventDefault();
    if (event.key === "Escape") {
      event.preventDefault();
      closeTester();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} value={text} />
      <div className="overflow-hidden rounded border border-border-bright/50 bg-editor-background shadow-xs transition has-[.cm-focused,input:focus]:ring-1 has-[.cm-focused,input:focus]:ring-border-bright">
        <div className="relative">
          <div
            ref={scrollRef}
            style={{ height: visibleHeight }}
            onKeyDownCapture={(event) => {
              // Keep Tab moving between form fields instead of indenting in the editor.
              if (event.key === "Tab") event.stopPropagation();
            }}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget) setAnimating(false);
            }}
            className={cn(
              // Only folding animates; typing resizes at once so the caret never scrolls the box.
              animating &&
                "transition-[height] duration-200 ease-out motion-reduce:transition-none",
              heights && heights.content > visibleHeight && !isFolded
                ? "overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
                : "overflow-clip"
            )}
          >
            <TextEditor
              defaultValue={defaultText}
              onChange={edit}
              onUpdate={onUpdate}
              onCreateEditor={(view) => {
                viewRef.current = view;
              }}
              extensions={extensions}
              showCopyButton={false}
            />
          </div>
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-editor-background to-transparent transition-opacity duration-200",
              isFolded ? "opacity-100" : "opacity-0"
            )}
          />
        </div>
        <div className="flex h-9 items-center gap-2 border-t border-grid-dimmed bg-background-bright pl-3 pr-1 text-xs">
          <div className="flex min-w-0 flex-1 items-center">
            {testing ? (
              <div className="flex min-w-0 flex-1 items-center gap-2 duration-200 animate-in fade-in slide-in-from-right-2">
                <input
                  autoFocus
                  aria-label="Path to test"
                  value={testPath}
                  onChange={(event) => setTestPath(event.target.value)}
                  onKeyDown={onTesterKeyDown}
                  placeholder="apps/web/src/index.ts"
                  className="h-6 min-w-0 flex-1 border-none bg-transparent p-0 font-mono text-xs text-text-bright outline-none placeholder:text-text-dimmed focus:ring-0"
                />
                <span
                  role="status"
                  className="flex min-w-0 max-w-[60%] items-center gap-1.5 text-text-dimmed"
                >
                  {path && (
                    <>
                      <VerdictBadge key={verdict} verdict={verdict} />
                      <span className="min-w-0 truncate">
                        {matchedIndex >= 0 ? (
                          <>
                            by{" "}
                            <span className="font-mono text-text-bright">
                              {lines[matchedIndex].pattern}
                            </span>
                          </>
                        ) : (
                          "no path matches"
                        )}
                      </span>
                    </>
                  )}
                </span>
              </div>
            ) : errors.length > 0 ? (
              <span className="truncate text-error">{plural(errors.length, "error")}</span>
            ) : patterns.length === 0 ? (
              <span className="truncate text-text-dimmed">
                No paths yet, so every push to a tracked branch deploys.
              </span>
            ) : null}
          </div>
          {(testing || canTest) && (
            <Button
              ref={testButtonRef}
              type="button"
              variant="minimal/small"
              LeadingIcon={FlaskConicalIcon}
              leadingIconClassName="text-indigo-400 transition-transform duration-200 group-hover/button:-rotate-12 light:text-indigo-600"
              className={cn(testing && "bg-indigo-500/15")}
              tooltip={testing ? "Close the path tester" : "Test a path"}
              aria-label={testing ? "Close the path tester" : "Test a path"}
              onClick={() => (testing ? closeTester() : setTesting(true))}
            />
          )}
          {canFold && (
            <Button
              type="button"
              variant="minimal/small"
              LeadingIcon={Chevron}
              tooltip={isFolded ? "Expand" : "Collapse"}
              aria-label={isFolded ? "Expand" : "Collapse"}
              onClick={toggleFold}
            />
          )}
        </div>
      </div>
      {errors.length > 0 && (
        <ul id={errorsId} className="flex flex-col gap-1 text-xs text-error">
          {errors.map((error) => (
            <li key={error} className="flex items-start gap-1.5">
              <ExclamationCircleIcon className="mt-px size-3.5 flex-none" />
              <span className="break-words">{error}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

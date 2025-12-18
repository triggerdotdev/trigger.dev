import { sql, StandardSQL } from "@codemirror/lang-sql";
import { autocompletion } from "@codemirror/autocomplete";
import { linter, lintGutter } from "@codemirror/lint";
import type { ViewUpdate } from "@codemirror/view";
import { CheckIcon, ClipboardIcon, SparklesIcon, TrashIcon } from "@heroicons/react/20/solid";
import {
  type ReactCodeMirrorProps,
  type UseCodeMirror,
  useCodeMirror,
} from "@uiw/react-codemirror";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { cn } from "~/utils/cn";
import { Button } from "../primitives/Buttons";
import { getEditorSetup } from "./codeMirrorSetup";
import { darkTheme } from "./codeMirrorTheme";
import { createTSQLCompletion } from "./tsql/tsqlCompletion";
import { createTSQLLinter } from "./tsql/tsqlLinter";
import type { TableSchema } from "@internal/tsql";
import { format as formatSQL } from "sql-formatter";

export interface TSQLEditorProps extends Omit<ReactCodeMirrorProps, "onBlur"> {
  /** Initial value for the editor */
  defaultValue?: string;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Called when the editor content changes */
  onChange?: (value: string) => void;
  /** Called when the editor state updates */
  onUpdate?: (update: ViewUpdate) => void;
  /** Called when the editor loses focus */
  onBlur?: (code: string) => void;
  /** Schema for table/column autocompletion */
  schema?: TableSchema[];
  /** Show copy button */
  showCopyButton?: boolean;
  /** Show clear button */
  showClearButton?: boolean;
  /** Show format button */
  showFormatButton?: boolean;
  /** Enable linting (syntax checking) */
  linterEnabled?: boolean;
  /** Placeholder text when empty */
  placeholder?: string;
  /** Additional actions to show in the toolbar */
  additionalActions?: React.ReactNode;
  /** Minimum height of the editor */
  minHeight?: string;
}

type TSQLEditorDefaultProps = Partial<TSQLEditorProps>;

const defaultProps: TSQLEditorDefaultProps = {
  readOnly: false,
  basicSetup: false,
  linterEnabled: true,
  showCopyButton: true,
  showClearButton: false,
  showFormatButton: true,
  schema: [],
};

export function TSQLEditor(opts: TSQLEditorProps) {
  const {
    defaultValue = "",
    readOnly = false,
    onChange,
    onUpdate,
    onBlur,
    basicSetup = false,
    autoFocus,
    showCopyButton = true,
    showClearButton = false,
    showFormatButton = true,
    linterEnabled = true,
    schema = [],
    placeholder = "",
    additionalActions,
    minHeight = undefined,
  } = {
    ...defaultProps,
    ...opts,
  };

  // Create extensions - memoize to avoid recreating on every render
  const extensions = useMemo(() => {
    const exts = getEditorSetup();

    // Add SQL language support with StandardSQL dialect
    // This provides syntax highlighting
    exts.push(
      sql({
        dialect: StandardSQL,
        upperCaseKeywords: true,
      })
    );

    // Add custom TSQL completion
    if (schema && schema.length > 0) {
      exts.push(
        autocompletion({
          override: [createTSQLCompletion(schema)],
          activateOnTyping: true,
          maxRenderedOptions: 50,
        })
      );
    }

    // Add TSQL linter
    if (linterEnabled) {
      exts.push(lintGutter());
      exts.push(
        linter(createTSQLLinter({ schema }), {
          delay: 300, // Debounce linting for better performance
        })
      );
    }

    return exts;
  }, [schema, linterEnabled]);

  const editor = useRef<HTMLDivElement>(null);

  const settings: Omit<UseCodeMirror, "onBlur"> = {
    ...opts,
    container: editor.current,
    extensions,
    editable: !readOnly,
    contentEditable: !readOnly,
    value: defaultValue,
    autoFocus,
    theme: darkTheme(),
    indentWithTab: false,
    basicSetup,
    onChange,
    onUpdate,
    placeholder,
  };

  const { setContainer, view } = useCodeMirror(settings);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (editor.current) {
      setContainer(editor.current);
    }
  }, [setContainer]);

  // Update editor when defaultValue changes
  useEffect(() => {
    if (view !== undefined) {
      if (view.state.doc.toString() === defaultValue) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: defaultValue },
      });
    }
  }, [defaultValue, view]);

  const clear = () => {
    if (view === undefined) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: undefined },
    });
    onChange?.("");
  };

  const copy = useCallback(() => {
    if (view === undefined) return;
    navigator.clipboard.writeText(view.state.doc.toString());
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 1500);
  }, [view]);

  const format = useCallback(() => {
    if (view === undefined) return;
    const currentContent = view.state.doc.toString();
    if (!currentContent.trim()) return;

    try {
      const formatted = formatSQL(currentContent, {
        language: "sql",
        keywordCase: "upper",
        indentStyle: "standard",
        linesBetweenQueries: 2,
      });
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: formatted },
      });
      onChange?.(formatted);
    } catch {
      // If formatting fails (e.g., invalid SQL), silently ignore
    }
  }, [view, onChange]);

  const showButtons = showClearButton || showCopyButton || showFormatButton || additionalActions;

  return (
    <div
      className={cn("relative flex h-full flex-col", opts.className)}
      style={minHeight ? { minHeight } : undefined}
    >
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        )}
        ref={editor}
        onBlur={() => {
          if (!onBlur) return;
          onBlur(editor.current?.textContent ?? "");
        }}
      />
      {showButtons && (
        <div className="absolute right-0 top-0 z-10 flex items-center justify-end bg-charcoal-900/80 p-0.5">
          {additionalActions && additionalActions}
          {showFormatButton && (
            <Button
              type="button"
              variant="minimal/small"
              className="flex-none"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                format();
              }}
              shortcut={{ key: "f", modifiers: ["shift", "alt"], enabledOnInputElements: true }}
            >
              Format
            </Button>
          )}
          {showClearButton && (
            <Button
              type="button"
              variant="minimal/small"
              TrailingIcon={TrashIcon}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clear();
              }}
            >
              Clear
            </Button>
          )}
          {showCopyButton && (
            <Button
              type="button"
              variant="minimal/small"
              TrailingIcon={copied ? CheckIcon : ClipboardIcon}
              trailingIconClassName={
                copied ? "text-green-500 group-hover:text-green-500" : undefined
              }
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                copy();
              }}
            >
              Copy
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

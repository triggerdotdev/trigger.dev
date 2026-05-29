import type { ViewUpdate } from "@codemirror/view";
import { EditorView, lineNumbers } from "@codemirror/view";
import { CheckIcon, ClipboardIcon } from "@heroicons/react/20/solid";
import type { ReactCodeMirrorProps, UseCodeMirror } from "@uiw/react-codemirror";
import { useCodeMirror } from "@uiw/react-codemirror";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { Button } from "../primitives/Buttons";
import { getEditorSetup } from "./codeMirrorSetup";
import { darkTheme } from "./codeMirrorTheme";

export interface TextEditorProps extends Omit<ReactCodeMirrorProps, "onBlur"> {
  defaultValue?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onUpdate?: (update: ViewUpdate) => void;
  showCopyButton?: boolean;
  additionalActions?: React.ReactNode;
}

export function TextEditor(opts: TextEditorProps) {
  const {
    defaultValue = "",
    readOnly = false,
    onChange,
    onUpdate,
    autoFocus,
    showCopyButton = true,
    additionalActions,
  } = opts;

  // Don't use default line numbers from setup — add our own with proper sizing
  const extensions = getEditorSetup(false);
  extensions.push(EditorView.lineWrapping);
  extensions.push(
    lineNumbers({
      formatNumber: (n) => String(n),
    })
  );
  extensions.push(
    EditorView.theme({
      ".cm-lineNumbers": {
        minWidth: "40px",
      },
    })
  );

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
    basicSetup: false,
    onChange,
    onUpdate,
  };
  const { setContainer, view } = useCodeMirror(settings);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (editor.current) {
      setContainer(editor.current);
    }
  }, [setContainer]);

  useEffect(() => {
    if (view !== undefined) {
      if (view.state.doc.toString() === defaultValue) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: defaultValue },
      });
    }
  }, [defaultValue, view]);

  const copy = useCallback(() => {
    if (view === undefined) return;
    navigator.clipboard.writeText(view.state.doc.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [view]);

  const showToolbar = showCopyButton || additionalActions;

  return (
    <div
      className={cn(
        "grid",
        showToolbar ? "grid-rows-[2.5rem_1fr]" : "grid-rows-[1fr]",
        opts.className
      )}
    >
      {showToolbar && (
        <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
          <div className="flex items-center">{additionalActions}</div>
          <div className="flex items-center gap-2">
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
        </div>
      )}
      <div className="min-h-0 min-w-0 overflow-auto" ref={editor} />
    </div>
  );
}

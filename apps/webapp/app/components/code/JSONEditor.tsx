import { json as jsonLang, jsonParseLinter } from "@codemirror/lang-json";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { CheckIcon, ClipboardIcon, TrashIcon } from "@heroicons/react/20/solid";
import type { ReactCodeMirrorProps, UseCodeMirror } from "@uiw/react-codemirror";
import { useCodeMirror } from "@uiw/react-codemirror";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { Button } from "../primitives/Buttons";
import { getEditorSetup } from "./codeMirrorSetup";
import { darkTheme } from "./codeMirrorTheme";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";

export interface JSONEditorProps extends Omit<ReactCodeMirrorProps, "onBlur"> {
  defaultValue?: string;
  language?: "json";
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onUpdate?: (update: ViewUpdate) => void;
  onBlur?: (code: string) => void;
  showCopyButton?: boolean;
  showClearButton?: boolean;
  linterEnabled?: boolean;
  allowEmpty?: boolean;
  additionalActions?: React.ReactNode;
}

const languages = {
  json: jsonLang,
};

function emptyAwareJsonLinter() {
  return (view: EditorView): Diagnostic[] => {
    const content = view.state.doc.toString().trim();

    // return no errors if content is empty
    if (!content) {
      return [];
    }

    return jsonParseLinter()(view);
  };
}

type JSONEditorDefaultProps = Partial<JSONEditorProps>;

const defaultProps: JSONEditorDefaultProps = {
  language: "json",
  readOnly: true,
  basicSetup: false,
  linterEnabled: true,
  allowEmpty: true,
};

export function JSONEditor(opts: JSONEditorProps) {
  const {
    defaultValue = "",
    language,
    readOnly,
    onChange,
    onUpdate,
    onBlur,
    basicSetup,
    autoFocus,
    showCopyButton = true,
    showClearButton = true,
    linterEnabled,
    allowEmpty,
    additionalActions,
  } = {
    ...defaultProps,
    ...opts,
  };

  console.log("JSONEditor opts", {
    defaultValue,
    language,
    readOnly,
    onChange,
    onUpdate,
    onBlur,
    basicSetup,
    autoFocus,
    showCopyButton,
    showClearButton,
    linterEnabled,
    allowEmpty,
    additionalActions,
  });

  const extensions = getEditorSetup();

  if (!language) throw new Error("language is required");
  const languageExtension = languages[language];

  extensions.push(languageExtension());

  if (linterEnabled) {
    extensions.push(lintGutter());

    switch (language) {
      case "json": {
        extensions.push(allowEmpty ? linter(emptyAwareJsonLinter()) : linter(jsonParseLinter()));
        break;
      }
      default:
        language satisfies never;
    }
  }

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
  };
  const { setContainer, view } = useCodeMirror(settings);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (editor.current) {
      setContainer(editor.current);
    }
  }, [setContainer]);

  //if the defaultValue changes update the editor
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

  const showButtons = showClearButton || showCopyButton;

  return (
    <div
      className={cn(
        "grid",
        showButtons ? "grid-rows-[2.5rem_1fr]" : "grid-rows-[1fr]",
        opts.className
      )}
    >
      {showButtons && (
        <div className="mx-3 flex items-center justify-end gap-2 border-b border-grid-dimmed">
          {additionalActions && additionalActions}
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
      <div
        className="w-full overflow-auto"
        ref={editor}
        onBlur={() => {
          if (!onBlur) return;
          onBlur(editor.current?.textContent ?? "");
        }}
      />
    </div>
  );
}

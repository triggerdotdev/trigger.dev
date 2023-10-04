import { json as jsonLang } from "@codemirror/lang-json";
import type { ViewUpdate } from "@codemirror/view";
import type { ReactCodeMirrorProps, UseCodeMirror } from "@uiw/react-codemirror";
import { useCodeMirror } from "@uiw/react-codemirror";
import { useRef, useEffect, useCallback } from "react";
import { getEditorSetup } from "./codeMirrorSetup";
import { darkTheme } from "./codeMirrorTheme";
import { cn } from "~/utils/cn";
import { Button } from "../primitives/Buttons";
import { ClipboardIcon } from "@heroicons/react/20/solid";

export interface JSONEditorProps extends Omit<ReactCodeMirrorProps, "onBlur"> {
  defaultValue?: string;
  language?: "json";
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onUpdate?: (update: ViewUpdate) => void;
  onBlur?: (code: string) => void;
  showCopyButton?: boolean;
  showClearButton?: boolean;
}

const languages = {
  json: jsonLang,
};

type JSONEditorDefaultProps = Partial<JSONEditorProps>;

const defaultProps: JSONEditorDefaultProps = {
  language: "json",
  readOnly: true,
  basicSetup: false,
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
  } = {
    ...defaultProps,
    ...opts,
  };

  const extensions = getEditorSetup();

  if (!language) throw new Error("language is required");
  const languageExtension = languages[language];

  extensions.push(languageExtension());

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
  const { setContainer, state } = useCodeMirror(settings);

  useEffect(() => {
    if (editor.current) {
      setContainer(editor.current);
    }
  }, [setContainer]);

  //if the defaultValue changes update the editor
  useEffect(() => {
    if (state !== undefined) {
      console.log("content updated to:");
      console.log(defaultValue);
      state.update({
        changes: { from: 0, to: state.doc.length, insert: defaultValue },
      });
    }
  }, [defaultValue, state]);

  const clear = useCallback(() => {
    if (state === undefined) return;
    onChange?.("");
  }, [state]);

  const copy = useCallback(() => {
    if (state === undefined) return;
    console.log("copying");
    console.log(state.doc.lines);
    navigator.clipboard.writeText(state.doc.toString());
  }, [state]);

  return (
    <div className={cn(opts.className, "relative")}>
      <div
        className="h-full w-full"
        ref={editor}
        onBlur={() => {
          if (!onBlur) return;
          onBlur(editor.current?.textContent ?? "");
        }}
      />
      <div className="absolute right-3 top-3 flex gap-2">
        {showClearButton && (
          <Button
            type="button"
            variant="secondary/small"
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
            variant="secondary/small"
            LeadingIcon={ClipboardIcon}
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
  );
}

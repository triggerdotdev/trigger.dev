import { json as jsonLang } from "@codemirror/lang-json";
import type { ViewUpdate } from "@codemirror/view";
import type {
  ReactCodeMirrorProps,
  UseCodeMirror,
} from "@uiw/react-codemirror";
import { useCodeMirror } from "@uiw/react-codemirror";
import { useRef, useEffect } from "react";
import { getEditorSetup } from "./codeMirrorSetup";
import { darkTheme } from "./codeMirrorTheme";
import { cn } from "~/utils/cn";

export interface JSONEditorProps extends Omit<ReactCodeMirrorProps, "onBlur"> {
  content?: string;
  language?: "json";
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onUpdate?: (update: ViewUpdate) => void;
  onBlur?: (code: string) => void;
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
    content,
    language,
    readOnly,
    onChange,
    onUpdate,
    onBlur,
    basicSetup,
    autoFocus,
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
    value: content,
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

  //if the content param changes, update the editor
  useEffect(() => {
    if (state !== undefined && content !== undefined) {
      state.update({
        changes: { from: 0, to: state.doc.length, insert: content },
      });
    }
  }, [content, state]);

  return (
    <div
      className={cn("no-scrollbar overflow-y-auto", opts.className)}
      ref={editor}
      onBlur={() => {
        if (!onBlur) return;
        onBlur(editor.current?.textContent ?? "");
      }}
    />
  );
}

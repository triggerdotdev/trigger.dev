import { json as jsonLang } from "@codemirror/lang-json";
import type { ViewUpdate } from "@codemirror/view";
import type {
  ReactCodeMirrorProps,
  UseCodeMirror,
} from "@uiw/react-codemirror";
import { useCodeMirror } from "@uiw/react-codemirror";
import classNames from "classnames";
import { useRef, useEffect } from "react";
import { getEditorSetup } from "./codeMirrorSetup";
import { darkTheme, lightTheme } from "./codeMirrorTheme";

export interface JSONEditorProps extends Omit<ReactCodeMirrorProps, "onBlur"> {
  content: string;
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
    autoFocus: false,
    theme: darkTheme(),
    indentWithTab: false,
    basicSetup,
    onChange,
    onUpdate,
  };
  const { setContainer } = useCodeMirror(settings);

  useEffect(() => {
    if (editor.current) {
      setContainer(editor.current);
    }
  }, [setContainer]);

  return (
    <div
      className={classNames("no-scrollbar overflow-y-auto", opts.className)}
      ref={editor}
      onBlur={() => {
        if (!onBlur) return;
        onBlur(editor.current?.textContent ?? "");
      }}
    />
  );
}

import { javascript } from "@codemirror/lang-javascript";
import type { ViewUpdate } from "@codemirror/view";
import type {
  ReactCodeMirrorProps,
  UseCodeMirror,
} from "@uiw/react-codemirror";
import { useCodeMirror } from "@uiw/react-codemirror";
import classNames from "classnames";
import { useRef, useEffect } from "react";
import { getEditorSetup } from "./codeMirrorSetup";
import { darkTheme } from "./codeMirrorTheme";

export interface CodeEditorProps extends Omit<ReactCodeMirrorProps, "onBlur"> {
  content: string;
  language?: "typescript" | "shell";
  showLineNumbers?: boolean;
  showHighlights?: boolean;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onUpdate?: (update: ViewUpdate) => void;
  onBlur?: (code: string) => void;
}

type CodeEditorDefaultProps = Partial<CodeEditorProps>;

const defaultProps: CodeEditorDefaultProps = {
  language: "typescript",
  showLineNumbers: true,
  showHighlights: true,
  readOnly: true,
  basicSetup: false,
};

export function CodeEditor(opts: CodeEditorProps) {
  const { content, readOnly, onChange, onUpdate, onBlur } = {
    ...defaultProps,
    ...opts,
  };

  const extensions = getEditorSetup(opts.showLineNumbers, opts.showHighlights);

  if (opts.language === "typescript") {
    extensions.push(javascript({ typescript: true }));
  }

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
    basicSetup: false,
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

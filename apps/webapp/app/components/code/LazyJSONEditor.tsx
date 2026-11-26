import { LazyLoad, lazyWithRetry } from "~/components/primitives/LazyLoad";
import type { JSONEditorProps } from "./JSONEditor";

// CodeMirror is one of the largest dependencies in the dashboard. Editors that only appear
// after a click (dialogs, menus) use this so the page around them doesn't wait for it.
const JSONEditor = lazyWithRetry(() =>
  import("./JSONEditor").then((module) => ({ default: module.JSONEditor }))
);

export function LazyJSONEditor(props: JSONEditorProps) {
  return (
    <LazyLoad fallback={<div className={props.className} />}>
      <JSONEditor {...props} />
    </LazyLoad>
  );
}

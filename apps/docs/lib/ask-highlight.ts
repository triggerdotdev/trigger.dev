// Code highlighting for Ask AI answers, in the browser. components/ask-answer.tsx imports this module
// lazily, so Shiki only loads once an answer has a code block, and each grammar only when used.
import { createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { triggerDark, triggerLight } from "./shiki-themes";

type Grammar = () => Promise<{ default: Parameters<HighlighterCore["loadLanguage"]>[0] }>;

// The languages the docs' own code blocks use.
const grammars: Record<string, Grammar> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
};

const aliases: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  bash: "shellscript",
  sh: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  console: "shellscript",
  yml: "yaml",
  py: "python",
  dockerfile: "docker",
};

/** The grammar name for a fence language, or undefined when Ask AI doesn't highlight it. */
export const grammarOf = (lang: string) => {
  const name = aliases[lang] ?? lang;
  return name in grammars ? name : undefined;
};

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();

/** Lines of tokens with the light and dark colors as `--shiki-light`/`--shiki-dark`, as on pages.
 * Null when the language isn't one the docs use. */
export async function highlightTokens(code: string, lang: string): Promise<ThemedToken[][] | null> {
  const name = grammarOf(lang);
  if (!name) return null;
  const hl = await (highlighter ??= createHighlighterCore({
    themes: [triggerLight, triggerDark],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  }));
  let load = loaded.get(name);
  if (!load) loaded.set(name, (load = grammars[name]!().then((m) => hl.loadLanguage(m.default))));
  await load;
  return hl.codeToTokens(code, {
    lang: name,
    themes: { light: triggerLight.name, dark: triggerDark.name },
    defaultColor: false,
  }).tokens;
}

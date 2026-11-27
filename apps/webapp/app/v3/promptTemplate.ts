import { z } from "zod";

export const PromptVariables = z.record(z.string(), z.unknown());

export function compilePromptTemplate(
  template: string,
  variables: Record<string, unknown>
): string {
  return compilePromptTemplateBounded(template, variables, Infinity).text;
}

// cut: substituted text passed the limit, so text may be partly substituted and must not be shown.
export function compilePromptTemplateBounded(
  template: string,
  variables: Record<string, unknown>,
  maxExpandedChars: number
): { text: string; cut: boolean } {
  let used = 0;
  const bounded = (convert: () => string) => {
    if (used > maxExpandedChars) return "";
    const text = convert();
    used += text.length;
    return text;
  };

  let result = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, key, content) => {
    const value = variables[key];
    return value
      ? content.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => {
          return bounded(() => String(variables[k] ?? ""));
        })
      : "";
  });

  result = result.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
    const value = variables[key];
    return value !== undefined && value !== null ? bounded(() => String(value)) : "";
  });

  return { text: result, cut: used > maxExpandedChars };
}

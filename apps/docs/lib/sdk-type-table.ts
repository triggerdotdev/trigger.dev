import { sdkTypes } from "@/.generated/sdk-types.js";

export type SdkTypeRow = {
  name: string;
  type: string;
  required: boolean;
  deprecated: boolean;
  default?: string;
  description: string;
};

/** The properties of a type exported from lib/sdk-types, generated at build (lib/sdk-type-gen.ts). */
export function sdkTypeRows(name: string): SdkTypeRow[] {
  const rows = sdkTypes[name];
  if (!rows) throw new Error(`<SdkType name="${name}" />: no such export in lib/sdk-types`);
  return rows;
}

const cell = (text: string) =>
  text
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim();
const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;

/** The same table as markdown, for .md, llms-full, MCP and Ask AI. */
function sdkTypeMarkdown(rows: SdkTypeRow[]) {
  const lines = [
    "| Property | Type | Required | Default | Description |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const desc = (r.deprecated ? "**Deprecated.** " : "") + r.description;
    const def = r.default ? cell(code(r.default)) : "";
    lines.push(
      `| ${cell(code(r.name))} | ${cell(code(r.type))} | ${r.required ? "yes" : "no"} | ${def} | ${cell(desc)} |`
    );
  }
  return lines.join("\n");
}

const SDK_TYPE_TAG = /<SdkType\s+name=["']([A-Za-z0-9_]+)["']\s*\/>/g;

/** Replaces each `<SdkType name="..." />` tag in page markdown with its markdown table. */
export const expandSdkTypes = (markdown: string) =>
  markdown.replace(SDK_TYPE_TAG, (_, name: string) => sdkTypeMarkdown(sdkTypeRows(name)));

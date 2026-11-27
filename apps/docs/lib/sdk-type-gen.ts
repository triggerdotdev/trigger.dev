import { readFileSync } from "node:fs";
import path from "node:path";
import { createGenerator } from "fumadocs-typescript";
import type { SdkTypeRow } from "./sdk-type-table";

// Build time only (scripts/build-search-index.mjs): runs TypeScript over lib/sdk-types/index.ts.

// The written type when it fits on the row ("string | string[]"), else a summary ("union").
const typeOf = (entry: { type: string; simplifiedType: string }) => {
  const type = entry.type.replace(/ \| undefined$/, "");
  return type.length <= 60 ? type : entry.simplifiedType;
};

const defaultOf = (tags: { name: string; text: string }[]) =>
  tags.find((t) => t.name === "default" || t.name === "defaultValue")?.text.replace(/^`|`$/g, "");

/** Rows for every type exported from lib/sdk-types/index.ts, read from the SDK's types and JSDoc. */
export async function generateSdkTypes(appDir: string): Promise<Record<string, SdkTypeRow[]>> {
  const file = path.join(appDir, "lib/sdk-types/index.ts");
  const generator = createGenerator({ tsconfigPath: path.join(appDir, "tsconfig.json") });
  const names = [...readFileSync(file, "utf8").matchAll(/^export type (\w+)/gm)].map((m) => m[1]!);
  const docs = (
    await Promise.all(names.map((name) => generator.generateTypeTable({ path: file, name })))
  ).flat();
  return Object.fromEntries(
    docs.map((doc) => [
      doc.name,
      doc.entries.map((entry) => ({
        name: entry.name,
        type: typeOf(entry),
        required: entry.required,
        deprecated: !!entry.deprecated,
        default: defaultOf(entry.tags),
        description: (entry.description ?? "").replace(/{@link ([^}]*)}/g, "$1"),
      })),
    ])
  );
}

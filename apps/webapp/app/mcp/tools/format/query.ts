import type { QuerySchemaTable } from "@trigger.dev/core/v3/schemas";

export function formatQueryResults(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "_No results_";

  const columns = Object.keys(rows[0]!);

  const hasComplex = rows.some((row) =>
    columns.some((col) => {
      const val = row[col];
      return val !== null && typeof val === "object";
    })
  );

  if (hasComplex) {
    return rows.map((row) => JSON.stringify(row)).join("\n");
  }

  const header = columns.join(" | ");
  const separator = columns.map(() => "---").join(" | ");
  const body = rows.map((row) =>
    columns
      .map((col) => {
        const val = row[col];
        return val === null || val === undefined ? "" : String(val);
      })
      .join(" | ")
  );

  return [header, separator, ...body].join("\n");
}

export function formatSchemaTable(table: QuerySchemaTable): string {
  const lines: string[] = [];

  lines.push(`### ${table.name}`);
  if (table.description) {
    lines.push(table.description);
  }
  if (table.timeColumn) {
    lines.push(`**Time column:** \`${table.timeColumn}\``);
  }
  lines.push("");

  lines.push("| Column | Type | Description |");
  lines.push("|--------|------|-------------|");

  for (const col of table.columns) {
    const parts: string[] = [];

    if (col.description) {
      parts.push(col.description);
    }
    if (col.allowedValues && col.allowedValues.length > 0) {
      parts.push(`Values: ${col.allowedValues.join(", ")}`);
    }
    if (col.example) {
      parts.push(`e.g. \`${col.example}\``);
    }

    const core = col.coreColumn ? " *" : "";
    const desc = parts.join(". ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

    lines.push(`| \`${col.name}\`${core} | ${col.type} | ${desc} |`);
  }

  lines.push("");
  lines.push("\\* = core column (included in default queries)");

  return lines.join("\n");
}

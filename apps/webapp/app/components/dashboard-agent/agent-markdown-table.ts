// Pure hast -> grid extraction, no DOM access. Structurally compatible with
// hast's `Element`/`Text` nodes (streamdown passes those as the `node` prop)
// without depending on the `hast` types package.
export type HastLikeNode = {
  type?: string;
  tagName?: string;
  children?: HastLikeNode[];
  value?: string;
};

export type MarkdownTableGrid = {
  columns: string[];
  rows: string[][];
};

export function textContent(node: HastLikeNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textContent).join("");
}

function childrenByTag(node: HastLikeNode | undefined, tagName: string): HastLikeNode[] {
  return (node?.children ?? []).filter((child) => child.tagName === tagName);
}

function cellsOf(row: HastLikeNode, cellTag: "th" | "td"): string[] {
  return childrenByTag(row, cellTag).map(textContent);
}

export function extractMarkdownTableGrid(node: HastLikeNode | undefined): MarkdownTableGrid {
  const [thead] = childrenByTag(node, "thead");
  const [tbody] = childrenByTag(node, "tbody");

  const headerRow = thead ? childrenByTag(thead, "tr")[0] : undefined;
  const columns = headerRow ? cellsOf(headerRow, "th") : [];

  const bodyRows = childrenByTag(tbody, "tr");
  const rows = bodyRows.map((row) => cellsOf(row, "td"));

  return { columns, rows };
}

function escapePipeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function gridToMarkdown(grid: MarkdownTableGrid): string {
  if (grid.columns.length === 0 && grid.rows.length === 0) return "";

  const columnCount = Math.max(grid.columns.length, ...grid.rows.map((row) => row.length), 0);
  const columns = Array.from(
    { length: columnCount },
    (_, i) => grid.columns[i] ?? `Column ${i + 1}`
  );

  const header = `| ${columns.map(escapePipeCell).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const rows = grid.rows.map((row) => {
    const cells = Array.from({ length: columnCount }, (_, i) => row[i] ?? "");
    return `| ${cells.map(escapePipeCell).join(" | ")} |`;
  });

  return [header, divider, ...rows].join("\n");
}

function escapeCSVCell(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function gridToCSV(grid: MarkdownTableGrid): string {
  const header = grid.columns.map(escapeCSVCell).join(",");
  const rows = grid.rows.map((row) => row.map(escapeCSVCell).join(","));
  return [header, ...rows].join("\n");
}

export function gridToJSON(grid: MarkdownTableGrid): string {
  const objects = grid.rows.map((row) =>
    Object.fromEntries(grid.columns.map((column, i) => [column || `column_${i + 1}`, row[i] ?? ""]))
  );
  return JSON.stringify(objects, null, 2);
}

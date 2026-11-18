import type { OutputColumnMetadata } from "@internal/clickhouse";
import { expect, it } from "vitest";
import { gridToCSV } from "~/components/dashboard-agent/agent-markdown-table";
import { rowsToCSV } from "~/utils/dataExport";

const toCSV = {
  agentTable: (cell: string) => gridToCSV({ columns: ["c"], rows: [[cell]] }),
  queryExport: (cell: string) => rowsToCSV([{ c: cell }], [{ name: "c" } as OutputColumnMetadata]),
};

// Catches: CSV exports letting a cell run as a spreadsheet formula, or a lone \r split a row.
it.each(Object.entries(toCSV))("%s neutralises formula cells", (_name, csv) => {
  expect(csv('=HYPERLINK("https://evil.example")')).toBe(
    'c\n"\'=HYPERLINK(""https://evil.example"")"'
  );
  expect(csv("@SUM(A1)")).toBe("c\n'@SUM(A1)");
  expect(csv("a\rb")).toBe('c\n"a\rb"');
  expect(csv("-12.5")).toBe("c\n-12.5");
  expect(csv("-1e-7")).toBe("c\n-1e-7");
  expect(csv("-1e308*2")).toBe("c\n'-1e308*2");
});

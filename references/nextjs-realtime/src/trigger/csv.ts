import { UploadedFileData } from "@/utils/schemas";
import { parse } from "@fast-csv/parse";
import { batch, logger, metadata, schemaTask } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";
import { CSVRow } from "./schemas";

export const handleCSVUpload = schemaTask({
  id: "handle-csv-upload",
  schema: UploadedFileData,
  run: async (file, { ctx }) => {
    logger.info("Handling uploaded files", { file });

    metadata.set("status", "fetching");

    const response = await fetch(file.url);

    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.statusText}`);
    }

    const body = await response.text();

    metadata.set("status", "parsing");

    const rows = await new Promise<Array<CSVRow>>((resolve, reject) => {
      const rows: Array<CSVRow> = [];

      const parser = parse({ headers: true });

      parser.on("data", (row) => {
        logger.info("Row", { row });

        const parsedRow = CSVRow.safeParse(row);

        if (parsedRow.success) {
          rows.push(parsedRow.data);
        } else {
          logger.warn("Failed to parse row", { row, errors: parsedRow.error });
        }
      });

      parser.on("end", () => {
        logger.info("CSV parsing complete");

        resolve(rows);
      });

      parser.on("error", reject);

      parser.write(body);
      parser.end();
    });

    metadata.set("status", "processing").set("totalRows", rows.length);

    const results = await batch.triggerAndWait<typeof handleCSVRow>(
      rows.map((row) => ({ id: "handle-csv-row", payload: row }))
    );

    metadata.set("status", "complete");

    const successfulRows = results.runs.filter((r) => r.ok);
    const failedRows = results.runs.filter((r) => !r.ok);

    return {
      file,
      rows,
      rowCount: rows.length,
      successCount: successfulRows.length,
      failedCount: failedRows.length,
    };
  },
});

export const handleCSVRow = schemaTask({
  id: "handle-csv-row",
  schema: CSVRow,
  run: async (row, { ctx }) => {
    logger.info("Handling CSV row", { row });

    // Simulate processing time
    await setTimeout(200 + Math.random() * 1012); // 200ms - 1.2s

    metadata.parent.increment("processedRows", 1).append("rowRuns", ctx.run.id);

    return row;
  },
});

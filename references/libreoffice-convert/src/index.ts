import { createTask } from "@trigger.dev/sdk/v3";
import libreofficeConvert from "libreoffice-convert";
import { z } from "zod";

/**
 * Task that converts Office documents (docx, pptx, xlsx) to PDF using LibreOffice.
 * Requires the `libreoffice()` build extension in trigger.config.ts.
 *
 * @example
 * ```ts
 * await client.tasks.call("libreoffice-convert", {
 *   params: {
 *     input: docxBuffer,   // Buffer containing the Office document
 *     outputFormat: "pdf",  // Output format (default: "pdf")
 *   }
 * });
 * ```
 */
export const libreofficeConvertTask = createTask({
  rpc: "libreoffice/convert",
  queue: {
    name: "libreoffice-convert",
    parallelLimit: 2,
  },
  schema: z.object({
    /** Buffer containing the Office document (docx, pptx, xlsx) */
    input: z.string().describe("Base64-encoded document buffer"),
    /** Output format. Only "pdf" is supported by libreoffice-convert. */
    outputFormat: z.string().optional().default("pdf"),
  }),
  async run(params): Promise<{ output: string }> {
    const inputBuffer = Buffer.from(params.input, "base64");
    const format = (params.outputFormat || "pdf") as Parameters<typeof libreofficeConvert>[1];

    const pdfBuffer = await libreofficeConvert(inputBuffer, format);

    return {
      output: pdfBuffer.toString("base64"),
    };
  },
});
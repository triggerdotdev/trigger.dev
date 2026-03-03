import { task } from "@trigger.dev/sdk";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Convert a .docx or .pptx file (supplied as a URL) to PDF using LibreOffice
 * running in headless mode — no X11 display required.
 *
 * Requires the `libreoffice()` build extension in trigger.config.ts so that
 * LibreOffice is available inside the deployed container.
 */
export const libreofficeConvert = task({
  id: "libreoffice-convert",
  run: async (payload: {
    /** Public URL of the .docx or .pptx file to convert. */
    documentUrl: string;
    /** Optional output filename (without extension). Defaults to "output". */
    outputName?: string;
  }) => {
    const { documentUrl, outputName = "output" } = payload;

    // Use a unique temp directory so concurrent runs don't collide.
    const workDir = join(tmpdir(), `lo-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });

    // Derive a safe input filename from the URL.
    const urlPath = new URL(documentUrl).pathname;
    const ext = urlPath.split(".").pop() ?? "docx";
    const inputPath = join(workDir, `input.${ext}`);
    // LibreOffice names the output after the input file stem.
    const outputPath = join(workDir, `input.pdf`);

    try {
      // 1. Download the source document.
      const response = await fetch(documentUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch document: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      writeFileSync(inputPath, Buffer.from(arrayBuffer));

      // 2. Convert to PDF using LibreOffice headless.
      //    --norestore prevents LibreOffice from showing a recovery dialog.
      //    --outdir directs the output file to our working directory.
      const libreofficeBin = process.env.LIBREOFFICE_PATH ?? "libreoffice";
      await execFileAsync(libreofficeBin, [
        "--headless",
        "--norestore",
        "--convert-to",
        "pdf",
        "--outdir",
        workDir,
        inputPath,
      ]);

      // 3. Read the resulting PDF.
      const pdfBuffer = readFileSync(outputPath);

      return {
        outputName: `${outputName}.pdf`,
        sizeBytes: pdfBuffer.byteLength,
        // Return base64 so the result is JSON-serialisable.
        // In production you would upload pdfBuffer to S3 / R2 instead.
        base64: pdfBuffer.toString("base64"),
      };
    } finally {
      // Clean up temp files.
      try {
        unlinkSync(inputPath);
      } catch {}
      try {
        unlinkSync(outputPath);
      } catch {}
    }
  },
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a temporary file with a custom filename, passes it to the callback function, and ensures cleanup
 * @param filename The filename to use for the temporary file
 * @param callback Function that receives the path to the temporary file
 * @param content Optional content to write to the file
 * @returns Whatever the callback returns
 */
export async function withTempFile<T>(
  filename: string,
  callback: (filePath: string) => Promise<T>,
  content: string | Buffer = ""
): Promise<T> {
  // Create temporary directory with random suffix
  const tempDir = await mkdtemp(join(tmpdir(), "app-"));
  const tempFile = join(tempDir, filename);

  try {
    // Write to the temporary file with appropriate permissions
    await writeFile(tempFile, content, { mode: 0o600 });
    // Use the file
    return await callback(tempFile);
  } finally {
    // Clean up
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function createTempFileSync(filename: string, content: string | Buffer = ""): string {
  const tempDir = mkdtempSync(join(tmpdir(), "app-"));
  const tempFile = join(tempDir, filename);

  writeFileSync(tempFile, content, { mode: 0o600 });
  return tempFile;
}

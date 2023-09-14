import { createWriteStream } from "node:fs";
import { createTempDir } from "./fileSystem";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import tar from "tar";

const streamPipeline = promisify(pipeline);

// A node.js function to download and extract a tarball to a temporary directory, and return the path to the directory.
export async function extractArchiveToTempDir(url: string, prefix: string): Promise<string> {
  const archiveTempDir = await createTempDir(`${prefix}-archive`);
  const tempDir = await createTempDir(prefix);
  const tempFilePath = `${archiveTempDir}/file.tgz`;

  // Download the .tgz file
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download .tgz file (${response.status} ${response.statusText})`);
  }

  if (!response.body) {
    throw new Error("Failed to download .tgz file (no body)");
  }

  const fileStream = createWriteStream(tempFilePath);
  // @ts-ignore
  await streamPipeline(response.body, fileStream);

  // Extract the contents to the temporary directory
  await tar.x({ C: tempDir, file: tempFilePath });

  return tempDir;
}

export async function downloadArchiveToTempDir(url: string, prefix: string): Promise<string> {
  const archiveTempDir = await createTempDir(`${prefix}-archive`);
  const tempFilePath = `${archiveTempDir}/file.tgz`;

  // Download the .tgz file
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download .tgz file (${response.status} ${response.statusText})`);
  }

  if (!response.body) {
    throw new Error("Failed to download .tgz file (no body)");
  }

  const fileStream = createWriteStream(tempFilePath);
  // @ts-ignore
  await streamPipeline(response.body, fileStream);

  return tempFilePath;
}

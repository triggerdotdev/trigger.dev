import fsModule, { mkdtemp, writeFile } from "node:fs/promises";
import fsSync from "node:fs";
import pathModule from "node:path";
import os from "node:os";

// Creates a file at the given path, if the directory doesn't exist it will be created
export async function createFile(path: string, contents: string): Promise<string> {
  await fsModule.mkdir(pathModule.dirname(path), { recursive: true });
  await fsModule.writeFile(path, contents);

  return path;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fsModule.access(path);

    return true;
  } catch (err) {
    return false;
  }
}

export async function removeFile(path: string) {
  await fsModule.unlink(path);
}

export async function readFile(path: string) {
  return await fsModule.readFile(path, "utf8");
}

export async function readJSONFile(path: string) {
  const fileContents = await fsModule.readFile(path, "utf8");

  return JSON.parse(fileContents);
}

export async function writeJSONFile(path: string, json: any) {
  await writeFile(path, JSON.stringify(json, null, 2));
}

export function readJSONFileSync(path: string) {
  const fileContents = fsSync.readFileSync(path, "utf8");

  return JSON.parse(fileContents);
}

export async function createTempDir(prefix: string) {
  return await mkdtemp(pathModule.join(os.tmpdir(), `${prefix}-`));
}

// Recursively list all the files in the directory, and returns an array a relative paths
export async function listFilesInDir(dir: string): Promise<string[]> {
  async function listFilesInDirRecursive(dir: string): Promise<string[]> {
    const files = await fsModule.readdir(dir);

    const filePaths = await Promise.all(
      files.map(async (file) => {
        const filePath = pathModule.join(dir, file);
        const stat = await fsModule.stat(filePath);

        if (stat.isDirectory()) {
          return await listFilesInDirRecursive(filePath);
        }

        return filePath;
      })
    );

    return filePaths.flat();
  }

  const allFiles = await listFilesInDirRecursive(dir);

  return allFiles.map((file) => pathModule.relative(dir, file));
}

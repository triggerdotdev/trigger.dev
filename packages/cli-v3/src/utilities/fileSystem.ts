import fsSync from "fs";
import fsModule, { writeFile } from "fs/promises";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import pathModule from "node:path";
import { parseJSONC, stringifyJSONC, parseTOML, stringifyTOML } from "confbox";

// Creates a file at the given path, if the directory doesn't exist it will be created
export async function createFile(
  path: string,
  contents: string | NodeJS.ArrayBufferView
): Promise<string> {
  await fsModule.mkdir(pathModule.dirname(path), { recursive: true });
  await fsModule.writeFile(path, contents);

  return path;
}

export function isDirectory(configPath: string) {
  try {
    return fs.statSync(configPath).isDirectory();
  } catch (error) {
    // ignore error
    return false;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return fsSync.existsSync(path);
}

export async function someFileExists(directory: string, filenames: string[]): Promise<boolean> {
  for (let index = 0; index < filenames.length; index++) {
    const filename = filenames[index];
    if (!filename) continue;

    const path = pathModule.join(directory, filename);
    if (await pathExists(path)) {
      return true;
    }
  }

  return false;
}

export async function removeFile(path: string) {
  await fsModule.unlink(path);
}

export async function readFile(path: string) {
  return await fsModule.readFile(path, "utf8");
}

export function expandTilde(filePath: string) {
  if (typeof filePath !== "string") {
    throw new TypeError("Path must be a string");
  }

  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return pathModule.resolve(homedir(), filePath.slice(2));
  }

  return pathModule.resolve(filePath);
}

export async function readJSONFile(path: string) {
  const fileContents = await fsModule.readFile(path, "utf8");

  return JSON.parse(fileContents);
}

export async function safeReadJSONFile(path: string) {
  try {
    const fileExists = await pathExists(path);

    if (!fileExists) return;

    const fileContents = await readFile(path);

    return JSON.parse(fileContents);
  } catch {
    return;
  }
}

export async function writeJSONFile(path: string, json: any, pretty = false) {
  await safeWriteFile(path, JSON.stringify(json, undefined, pretty ? 2 : undefined));
}

// Will create the directory if it doesn't exist
export async function safeWriteFile(path: string, contents: string) {
  await fsModule.mkdir(pathModule.dirname(path), { recursive: true });
  await fsModule.writeFile(path, contents);
}

export function readJSONFileSync(path: string) {
  const fileContents = fsSync.readFileSync(path, "utf8");

  return JSON.parse(fileContents);
}

export function safeDeleteFileSync(path: string) {
  try {
    fs.unlinkSync(path);
  } catch (error) {
    // ignore error
  }
}

// Create a temporary directory within the OS's temp directory
export async function createTempDir(): Promise<string> {
  // Generate a unique temp directory path
  const tempDirPath: string = pathModule.join(tmpdir(), "trigger-");

  // Create the temp directory synchronously and return the path
  const directory = await fsModule.mkdtemp(tempDirPath);

  return directory;
}

export async function safeReadTomlFile(path: string) {
  const fileExists = await pathExists(path);

  if (!fileExists) return;

  const fileContents = await readFile(path);

  return parseTOML(fileContents.replace(/\r\n/g, "\n"));
}

export async function writeTomlFile(path: string, toml: any) {
  await safeWriteFile(path, stringifyTOML(toml));
}

export async function safeReadJSONCFile(path: string) {
  const fileExists = await pathExists(path);

  if (!fileExists) return;

  const fileContents = await readFile(path);

  return parseJSONC(fileContents.replace(/\r\n/g, "\n"));
}

export async function writeJSONCFile(path: string, json: any) {
  await safeWriteFile(path, stringifyJSONC(json));
}

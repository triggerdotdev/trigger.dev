import fsModule, { writeFile } from "fs/promises";
import fsSync from "fs";
import pathModule from "path";

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

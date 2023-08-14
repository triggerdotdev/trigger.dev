import fs, { promises } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

export async function fileFromString(contents: string | Buffer, fileName: string): Promise<File> {
  const directory = path.join("tmp", uuidv4());
  await promises.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, fileName);
  await promises.writeFile(filePath, contents);
  return fs.createReadStream(filePath) as unknown as File;
}

export async function fileFromUrl(url: string) {
  const response = await fetch(url);
  const content = await response.buffer();
  const fileName = path.basename(url);

  return fileFromString(content, fileName);
}

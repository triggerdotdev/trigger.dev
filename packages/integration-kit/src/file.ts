import fs, { promises } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

export async function fileFromString(contents: string, fileName: string) {
  const directory = path.join("tmp", uuidv4());
  await promises.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, fileName);
  await promises.writeFile(filePath, contents);
  return fs.createReadStream(filePath);
}

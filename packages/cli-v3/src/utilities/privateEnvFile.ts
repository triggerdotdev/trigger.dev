import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function writePrivateEnvFile(
  outputPath: string,
  content: string,
  flags: "wx" | "w"
): Promise<void> {
  const openFlags = flags === "wx" ? flags : constants.O_WRONLY | constants.O_CREAT;
  const file = await open(outputPath, openFlags, 0o600);

  try {
    await file.chmod(0o600);
    await file.truncate(0);
    await file.writeFile(content, { encoding: "utf8" });
  } finally {
    await file.close();
  }
}

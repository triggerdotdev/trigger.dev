import path from "path";
import fs from "fs-extra";

export async function createDotEnvFile(projectPath: string, apiKey?: string) {
  const envPath = path.join(projectPath, ".env");
  const envExists = await fs.pathExists(envPath);
  if (envExists) {
    return;
  }
  const envContents = apiKey
    ? `TRIGGER_API_KEY=${apiKey}`
    : "TRIGGER_API_KEY=<enter your API key here>";
  await fs.writeFile(envPath, envContents);
}

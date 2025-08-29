import { readFileSync } from "fs";
import { env } from "./env.js";

export function getWorkerToken() {
  if (!env.TRIGGER_WORKER_TOKEN.startsWith("file://")) {
    return env.TRIGGER_WORKER_TOKEN;
  }

  const tokenPath = env.TRIGGER_WORKER_TOKEN.replace("file://", "");

  console.debug(
    JSON.stringify({
      message: "🔑 Reading worker token from file",
      tokenPath,
    })
  );

  try {
    const token = readFileSync(tokenPath, "utf8").trim();
    return token;
  } catch (error) {
    console.error(`Failed to read worker token from file: ${tokenPath}`, error);
    throw new Error(
      `Unable to read worker token from file: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

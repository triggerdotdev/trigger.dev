import fs from "fs/promises";
import pathModule from "path";

/** Detects if the project is a Next.js project at path  */
export async function detectNextJsProject(path: string): Promise<boolean> {
  // Checks for the presence of a next.config.js file
  try {
    // Check if next.config.js file exists in the given path
    await fs.access(pathModule.join(path, "next.config.js"));
    return true;
  } catch (error) {
    // If next.config.js file doesn't exist, it's not a Next.js project
    return false;
  }
}

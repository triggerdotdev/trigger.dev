import path from "path";
import { fileURLToPath } from "url";

export function rootPath() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return __dirname;
}

export function templatesPath() {
  const root = rootPath();
  const templatePath = path.join(root, "templates");
  return templatePath;
}

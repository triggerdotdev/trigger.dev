import path from "path";
import { fileURLToPath } from "url";

// With the move to TSUP as a build tool, this keeps path routes in other files (installers, loaders, etc) in check more easily.
// Path is in relation to a single index.js file inside ./dist
const __filename = fileURLToPath(import.meta.url);
const distPath = path.dirname(__filename);
export const PKG_ROOT = path.join(distPath, "../");

export const TITLE_TEXT = `                                               
 _____       _                           _           
|_   _| ___ |_| ___  ___  ___  ___     _| | ___  _ _ 
  | |  |  _|| || . || . || -_||  _| _ | . || -_|| | |
  |_|  |_|  |_||_  ||_  ||___||_|  |_||___||___| \\_/ 
               |___||___|                            
`;

export const DEFAULT_APP_NAME = "my-triggers";
export const CREATE_TRIGGER = "create-trigger";
export const TEMPLATE_ORGANIZATION = "triggerdotdev";
export const TRIGGER_BASE_URL =
  process.env.TRIGGER_BASE_URL ?? "https://app.trigger.dev";

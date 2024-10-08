// Use a global variable to store the base path
let globalBasePath: string = "http://localhost:3000";

export function setGlobalBasePath(basePath: string) {
  globalBasePath = basePath;
}

export function getGlobalBasePath() {
  return globalBasePath;
}

export type JSONPointer = string;

export function createJSONPointer(path: string): JSONPointer {
  return path.replace(/\/\//g, "/~1").replace(/~/g, "~0").replace(/#/g, "");
}

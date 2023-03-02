import JsonPointer from "json-pointer";

export type JSONPointer = string;

export function createJSONPointer(path: string[]): JSONPointer {
  return JsonPointer.compile(path);
}

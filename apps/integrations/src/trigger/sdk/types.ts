import { JSONSchema } from "core/schemas/types";

export type FunctionData = {
  type: "action" | "event";
  title: string;
  name: string;
  friendlyName: string;
  description: string;
  input?: JSONSchema;
  output?: JSONSchema;
  functionCode: string;
};

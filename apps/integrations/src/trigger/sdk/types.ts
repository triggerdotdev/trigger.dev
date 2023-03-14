import { SchemaRef } from "core/schemas/types";

export type FunctionData = {
  type: "action" | "event";
  title: string;
  name: string;
  friendlyName: string;
  description: string;
  inputRef?: SchemaRef;
  outputRef?: SchemaRef;
  functionCode: string;
};

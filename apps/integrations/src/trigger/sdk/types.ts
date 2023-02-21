import { JSONSchema } from "core/schemas/types";

export type FunctionData = {
  title: string;
  name: string;
  friendlyName: string;
  description: string;
  input?: JSONSchema;
  output?: JSONSchema;
  functionCode: string;
};

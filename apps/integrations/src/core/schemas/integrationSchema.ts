import { JSONSchema } from "./types";

export type IntegrationSchema = {
  definitions: Record<string, JSONSchema>;
};

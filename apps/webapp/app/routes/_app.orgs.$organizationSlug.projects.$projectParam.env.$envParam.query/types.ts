/**
 * Time filter configuration that can be set by the AI.
 * Used across both server and client code for AI query generation.
 */
export type AITimeFilter = {
  period?: string;
  from?: string;
  to?: string;
};

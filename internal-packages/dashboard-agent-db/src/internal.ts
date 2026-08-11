import type { DashboardAgentDb } from "./client.js";

// Shared by the query modules. Not part of the package's surface.

export type DashboardAgentDbOrTx =
  | DashboardAgentDb
  | Parameters<Parameters<DashboardAgentDb["transaction"]>[0]>[0];

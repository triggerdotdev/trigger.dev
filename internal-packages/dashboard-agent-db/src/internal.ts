import type { DashboardAgentDb } from "./client.js";

type DashboardAgentTx = Parameters<Parameters<DashboardAgentDb["transaction"]>[0]>[0];

export type DashboardAgentDbOrTx = DashboardAgentDb | DashboardAgentTx;

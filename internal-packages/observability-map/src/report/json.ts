import type { MapReport } from "../score.js";

export function renderJson(report: MapReport): string {
  return JSON.stringify(report, null, 2);
}

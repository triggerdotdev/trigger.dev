import { parseExpression } from "cron-parser";

export function isValidCronExpression(expression: string) {
  try {
    parseExpression(expression);
    return true;
  } catch (_err) {
    return false;
  }
}

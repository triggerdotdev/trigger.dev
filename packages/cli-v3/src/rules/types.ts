import { z } from "zod";

export const RulesFileInstallStrategy = z.enum(["default", "claude-code-subagent"]);
export type RulesFileInstallStrategy = z.infer<typeof RulesFileInstallStrategy>;

import { z } from "zod";

export const RulesFileInstallStrategy = z.enum(["skills"]);
export type RulesFileInstallStrategy = z.infer<typeof RulesFileInstallStrategy>;

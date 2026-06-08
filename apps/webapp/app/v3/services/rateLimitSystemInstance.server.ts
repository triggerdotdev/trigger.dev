import { prisma } from "~/db.server";
import { RateLimitSystem } from "./rateLimitSystem.server";
import { singleton } from "~/utils/singleton";

export const rateLimitSystem = singleton(
  "rateLimitSystem",
  () => new RateLimitSystem(prisma)
);

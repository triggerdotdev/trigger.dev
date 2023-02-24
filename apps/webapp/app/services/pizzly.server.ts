import { Nango } from "@nangohq/node";
import { env } from "~/env.server";

export const nango = new Nango({
  host: env.PIZZLY_HOST,
  secretKey: env.PIZZLY_SECRET_KEY,
});

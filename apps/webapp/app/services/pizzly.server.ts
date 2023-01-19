import { Pizzly } from "@nangohq/pizzly-node";
import { env } from "~/env.server";

export const pizzly = new Pizzly(env.PIZZLY_HOST, env.PIZZLY_SECRET_KEY);

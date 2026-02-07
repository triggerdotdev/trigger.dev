import { env } from "~/env.server";
import { LoopsClient } from "./loops.server";

export const loopsClient = env.LOOPS_API_KEY ? new LoopsClient(env.LOOPS_API_KEY) : null;

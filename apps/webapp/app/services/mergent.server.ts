import Mergent from "mergent";
import { env } from "~/env.server";

export const mergent = new Mergent(env.MERGENT_KEY);

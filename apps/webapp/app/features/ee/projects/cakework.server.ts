import {
  CakeworkApiClient,
  CakeworkApiEnvironment,
} from "@cakework/client/dist";
import { env } from "~/env.server";

export const cakework = new CakeworkApiClient({
  environment: CakeworkApiEnvironment.Production,
  xApiKey: env.CAKEWORK_API_KEY,
});

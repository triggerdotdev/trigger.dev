import { client } from "@/trigger";
import { makeHandler } from "@trigger.dev/nextjs";

export default makeHandler(client, { path: "/api/trigger" });

export const config = {
  api: {
    bodyParser: false,
  },
};

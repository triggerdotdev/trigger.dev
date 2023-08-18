import { triggerClient } from "./trigger";
import { createExpressServer } from "@trigger.dev/express";

const app = createExpressServer(
  triggerClient,
  process.env.PORT ? parseInt(process.env.PORT) : 3000
);

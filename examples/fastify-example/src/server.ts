import fastify from "fastify";
import { createMiddleware } from "@trigger.dev/fastify";
import { client } from "./trigger";
import "dotenv/config";

const app = fastify({
  logger: true,
});

const middleware = createMiddleware(client);

app.addHook("preHandler", middleware);

app.listen({ port: 3000 }, () => {
  console.log("Listening on port 3000");
});

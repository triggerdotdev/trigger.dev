import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config.js";
import trigger from "@trigger.dev/convex/convex.config.js";

const app = defineApp({ httpPrefix: "/api" });
app.use(trigger);
app.use(staticHosting, { httpPrefix: "/" });
export default app;

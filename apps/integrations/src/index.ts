import { handleAction } from "api/v2/action";
import { handleActionDisplay } from "api/v2/action/display";
import { handleServices } from "api/v2/services";
import * as Sentry from "@sentry/node";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import express, { Express, NextFunction, Request, Response } from "express";
import morgan from "morgan";
import { handleCreateWebhook } from "api/v2/webhooks/create";
import { handleReceivingWebhook } from "api/v2/webhooks/receive";
dotenv.config();

const app: Express = express();
const port = process.env.PORT ?? 3006;

// The request handler must be the first middleware on the app
Sentry.init({
  dsn: "https://bf96820b08004fa4b2e1506f2ac74a14@o4504419574087680.ingest.sentry.io/4504419607052288",
});
app.use(Sentry.Handlers.requestHandler());

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(morgan("combined"));

const checkAuthentication = function (
  req: Request,
  res: Response,
  next: NextFunction
) {
  //if the path is /healthcheck, skip authentication
  if (req.path === "/healthcheck") {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).send("Unauthorized");
    return;
  }

  const auth = authHeader.split(" ");
  if (auth.length !== 2 || auth[0] !== "Bearer") {
    res.status(401).send("Unauthorized");
    return;
  }

  const token = auth[1];
  if (token !== process.env.API_TOKEN) {
    res.status(401).send("Unauthorized");
    return;
  }

  next();
};

app.use(checkAuthentication);

app.get("/", (req: Request, res: Response) => {
  res.send("Trigger.dev integrations service");
});
app.get("/healthcheck", (req: Request, res: Response) => {
  res.send("OK");
});

//services
app.get("/api/v2/services", handleServices);

//requests
app.post("/api/v2/:service/action/:action/display", handleActionDisplay);
app.post("/api/v2/:service/action/:action", handleAction);

//webhooks
app.post("/api/v2/webhooks", handleCreateWebhook);
app.all("/api/v2/webhooks/:webhookId/receive", handleReceivingWebhook);

//errors
app.get("/debug-sentry", function mainHandler(req, res) {
  throw new Error("My first Sentry error!");
});

// The error handler must be before any other error middleware and after all controllers
app.use(Sentry.Handlers.errorHandler());

// Optional fallthrough error handler
app.use(function onError(err: any, req: any, res: any, next: any) {
  // The error id is attached to `res.sentry` to be returned
  // and optionally displayed to the user for support.
  res.statusCode = 500;
  res.end(res.sentry + "\n");
});

app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});

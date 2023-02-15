import { handleAction } from "api/v2/action";
import { handleActionDisplay } from "api/v2/action/display";
import { handleServices } from "api/v2/services";
import dotenv from "dotenv";
import express, { Express, NextFunction, Request, Response } from "express";
import morgan from "morgan";

dotenv.config();

const app: Express = express();
const port = process.env.PORT ?? 3006;

app.use(morgan("combined"));
app.use(express.json());

const checkAuthentication = function (
  req: Request,
  res: Response,
  next: NextFunction
) {
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
app.get("/api/v2/services", handleServices);
app.post("/api/v2/:service/action/:action/display", handleActionDisplay);
app.post("/api/v2/:service/action/:action", handleAction);

app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});

import express, { Express, Request, Response } from "express";
import dotenv from "dotenv";
import { handleAction } from "api/action";
dotenv.config();

const app: Express = express();
const port = process.env.PORT ?? 3006;

app.get("/", (req: Request, res: Response) => {
  res.send("Trigger.dev integrations service");
});

app.post("/api/:service/action/:action", handleAction);

app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});

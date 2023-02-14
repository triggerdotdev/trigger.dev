import express, { Express, Request, Response } from "express";
import dotenv from "dotenv";
import { handleAction } from "api/v1/action";
import { handleServices } from "api/v1/services";
dotenv.config();

const app: Express = express();
const port = process.env.PORT ?? 3006;

app.use(express.json());

app.get("/", (req: Request, res: Response) => {
  res.send("Trigger.dev integrations service");
});
app.get("/api/v1/services", handleServices);
app.post("/api/v1/:service/action/:action", handleAction);

app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});

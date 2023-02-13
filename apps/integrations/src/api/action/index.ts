import { Request, Response } from "express";

export function handleAction(req: Request, res: Response) {
  res.send("Slack 3");
}

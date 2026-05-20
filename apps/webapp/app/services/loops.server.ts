import { env } from "~/env.server";
import { logger } from "./logger.server";

class LoopsClient {
  constructor(private readonly apiKey: string) {}

  async userCreated({
    userId,
    email,
    name,
  }: {
    userId: string;
    email: string;
    name: string | null;
  }) {
    logger.info(`Loops send "sign-up" event`, { userId, email, name });
    return this.#sendEvent({
      email,
      userId,
      firstName: name?.split(" ").at(0),
      eventName: "sign-up",
    });
  }

  async vercelIntegrationStarted({
    userId,
    email,
    name,
  }: {
    userId: string;
    email: string;
    name: string | null;
  }) {
    logger.info(`Loops send "vercel-integration" event`, { userId, email, name });
    return this.#sendEvent({
      email,
      userId,
      firstName: name?.split(" ").at(0),
      eventName: "vercel-integration",
    });
  }

  async #sendEvent({
    email,
    userId,
    firstName,
    eventName,
    eventProperties,
  }: {
    email: string;
    userId: string;
    firstName?: string;
    eventName: string;
    eventProperties?: Record<string, string | number | boolean>;
  }) {
    const options = {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        userId,
        firstName,
        eventName,
        eventProperties,
      }),
    };

    try {
      const response = await fetch("https://app.loops.so/api/v1/events/send", options);

      if (!response.ok) {
        logger.error(`Loops sendEvent ${eventName} bad status`, {
          status: response.status,
          email,
          userId,
          firstName,
          eventProperties,
          eventName,
        });
        return false;
      }

      const responseBody = (await response.json()) as any;

      if (!responseBody.success) {
        logger.error(`Loops sendEvent ${eventName} failed response`, {
          message: responseBody.message,
        });
        return false;
      }

      return true;
    } catch (error) {
      logger.error(`Loops sendEvent ${eventName} failed`, { error });
      return false;
    }
  }
}

export const loopsClient = env.LOOPS_API_KEY ? new LoopsClient(env.LOOPS_API_KEY) : null;

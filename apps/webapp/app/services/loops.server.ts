import { logger as defaultLogger } from "./logger.server";

type Logger = Pick<typeof defaultLogger, "info" | "error">;

export class LoopsClient {
  #logger: Logger;

  constructor(
    private readonly apiKey: string,
    logger: Logger = defaultLogger
  ) {
    this.#logger = logger;
  }

  async userCreated({
    userId,
    email,
    name,
  }: {
    userId: string;
    email: string;
    name: string | null;
  }) {
    this.#logger.info(`Loops send "sign-up" event`, { userId, email, name });
    return this.#sendEvent({
      email,
      userId,
      firstName: name?.split(" ").at(0),
      eventName: "sign-up",
    });
  }

  async deleteContact({ email }: { email: string }): Promise<boolean> {
    this.#logger.info(`Loops deleting contact`, { email });

    try {
      const response = await fetch("https://app.loops.so/api/v1/contacts/delete", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        this.#logger.error(`Loops deleteContact bad status`, { status: response.status, email });
        return false;
      }

      const responseBody = (await response.json()) as { success: boolean; message?: string };

      if (!responseBody.success) {
        // "Contact not found" means already deleted - treat as success
        if (responseBody.message === "Contact not found.") {
          this.#logger.info(`Loops contact already deleted`, { email });
          return true;
        }
        this.#logger.error(`Loops deleteContact failed response`, {
          message: responseBody.message,
          email,
        });
        return false;
      }

      return true;
    } catch (error) {
      this.#logger.error(`Loops deleteContact failed`, { error, email });
      return false;
    }
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
        this.#logger.error(`Loops sendEvent ${eventName} bad status`, {
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
        this.#logger.error(`Loops sendEvent ${eventName} failed response`, {
          message: responseBody.message,
        });
        return false;
      }

      return true;
    } catch (error) {
      this.#logger.error(`Loops sendEvent ${eventName} failed`, { error });
      return false;
    }
  }
}

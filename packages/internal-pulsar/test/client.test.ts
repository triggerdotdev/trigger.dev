import { describe, expect, test } from "@jest/globals";
import * as dotenv from "dotenv";

import { createPulsarClient } from "../src";
import type { PulsarMessage } from "../src";

describe("Client", () => {
  test("should be able to create a client with no arguments", async () => {
    const client = createPulsarClient();

    expect(client).toBeDefined();

    expect(await client.close()).toBeNull();
  });

  test("should be able to create a client with an authentication token", async () => {
    const client = createPulsarClient({
      serviceUrl: "pulsar://localhost:6650",
      token: "asdasd",
      operationTimeoutSeconds: 3,
    });

    expect(client).toBeDefined();

    await client.close();
  });

  test("should be able to create a client with oauth credentials from the env", async () => {
    const result = dotenv.config({ override: true });

    const client = createPulsarClient({
      operationTimeoutSeconds: 3,
    });

    if (result.error) {
      return;
    }

    expect(client).toBeDefined();

    try {
      const producer = await client.createProducer({
        topic: "persistent://eric/default/oauth-topic",
      });

      expect(producer).toBeDefined();

      const subscriber = await client.subscribe({
        topic: "persistent://eric/default/oauth-topic",
        subscription: "my-subscription",
        subscriptionType: "Shared",
        subscriptionInitialPosition: "Latest",
      });

      expect(subscriber).toBeDefined();

      for (let i = 0; i < 10; i += 1) {
        await producer.send({
          data: Buffer.from(`Hello, OAuth! ${i}`),
        });
      }

      const receivedMessages: Array<PulsarMessage> = [];

      // Receive messages
      for (let i = 0; i < 10; i += 1) {
        const msg = await subscriber.receive();
        receivedMessages.push(msg);
        await subscriber.acknowledge(msg);
      }

      expect(receivedMessages.length).toBe(10);

      // Remove the environment variables from the dotenv.config result
      Object.keys(result.parsed ?? {}).forEach((key) => {
        delete process.env[key];
      });

      await subscriber.close();
      await producer.close();
      await client.close();
    } catch (error) {
      console.error(error);

      await client.close();

      throw error;
    }
  });
});

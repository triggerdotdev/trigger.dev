import { describe, expect, it, vi } from "vitest";
import { z as z3 } from "zod/v3";
import { z as z4 } from "zod/v4";
import { ZodMessageSender, sendMessageInCatalog } from "./zodMessageHandler.js";

const schemas = [
  [
    "Zod 3",
    z3.object({ value: z3.string().transform(Number), added: z3.string().default("default") }),
  ],
  [
    "Zod 4",
    z4.object({ value: z4.string().transform(Number), added: z4.string().default("default") }),
  ],
] as const;

describe("Zod message sending", () => {
  it.each(schemas)("ZodMessageSender preserves the original %s payload", async (_name, schema) => {
    const catalog = { TEST: schema };
    const payload = { value: "42", extra: "preserved" };
    const sender = vi.fn(async (_message: unknown) => {});
    const messageSender = new ZodMessageSender({ schema: catalog, sender });

    await messageSender.send("TEST", payload);

    expect(sender).toHaveBeenCalledWith({ type: "TEST", payload, version: "v1" });
  });

  it.each(schemas)(
    "sendMessageInCatalog preserves the original %s payload",
    async (_name, schema) => {
      const catalog = { TEST: schema };
      const payload = { value: "42", extra: "preserved" };
      const sender = vi.fn(async (_message: unknown) => {});

      await sendMessageInCatalog(catalog, "TEST", payload, sender);

      expect(sender).toHaveBeenCalledWith({ type: "TEST", payload, version: "v1" });
    }
  );
});

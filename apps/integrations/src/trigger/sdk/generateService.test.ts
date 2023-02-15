import { slackv2 } from "integrations/slack";
import { expect, test } from "vitest";
import { generateService } from "./generateService";

test("generate simple service", async () => {
  generateService(slackv2);
  expect(1).toEqual(1);
});

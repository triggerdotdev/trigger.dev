import { slack } from "integrations/slack";
import { expect, test } from "vitest";
import { generateService } from "./generateService";

test("generate simple service", async () => {
  generateService(slack);

  expect(1).toEqual(1);
});

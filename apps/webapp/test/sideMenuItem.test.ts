import { describe, expect, it } from "vitest";
import { isRouteActive } from "~/components/navigation/SideMenuItem";

describe("isRouteActive", () => {
  const envPath = "/orgs/my-org/projects/my-proj/env/dev";

  describe("exact matching", () => {
    it("returns true when pathName matches to exactly", () => {
      expect(isRouteActive({ pathName: `${envPath}/runs`, to: `${envPath}/runs` })).toBe(true);
    });

    it("returns false when pathName does not match and matchPrefix is false", () => {
      expect(
        isRouteActive({
          pathName: `${envPath}/runs/run_123`,
          to: `${envPath}/runs`,
          matchPrefix: false,
        })
      ).toBe(false);
    });
  });

  describe("boolean matchPrefix", () => {
    it("matches child routes when matchPrefix is true", () => {
      expect(
        isRouteActive({
          pathName: `${envPath}/runs/run_123`,
          to: `${envPath}/runs`,
          matchPrefix: true,
        })
      ).toBe(true);

      expect(
        isRouteActive({
          pathName: `${envPath}/runs/run_123/stream`,
          to: `${envPath}/runs`,
          matchPrefix: true,
        })
      ).toBe(true);
    });

    it("does not match sibling routes with matching prefix text but different segment", () => {
      expect(
        isRouteActive({
          pathName: `${envPath}/runs-metrics`,
          to: `${envPath}/runs`,
          matchPrefix: true,
        })
      ).toBe(false);
      expect(
        isRouteActive({
          pathName: `${envPath}/concurrency-limits`,
          to: `${envPath}/concurrency`,
          matchPrefix: true,
        })
      ).toBe(false);
    });

    it("matches exact route even with matchPrefix: true", () => {
      expect(
        isRouteActive({
          pathName: `${envPath}/runs`,
          to: `${envPath}/runs`,
          matchPrefix: true,
        })
      ).toBe(true);
    });
  });

  describe("custom string matchPrefix", () => {
    it("matches when pathName equals the custom prefix", () => {
      expect(
        isRouteActive({
          pathName: `${envPath}/tasks`,
          to: envPath,
          matchPrefix: `${envPath}/tasks`,
        })
      ).toBe(true);
    });

    it("matches child routes of the custom prefix", () => {
      expect(
        isRouteActive({
          pathName: `${envPath}/tasks/standard/my-task`,
          to: envPath,
          matchPrefix: `${envPath}/tasks`,
        })
      ).toBe(true);
      expect(
        isRouteActive({
          pathName: `${envPath}/tasks/scheduled/cron-task`,
          to: envPath,
          matchPrefix: `${envPath}/tasks`,
        })
      ).toBe(true);
      expect(
        isRouteActive({
          pathName: `${envPath}/tasks/stream`,
          to: envPath,
          matchPrefix: `${envPath}/tasks`,
        })
      ).toBe(true);
    });

    it("does not match other environment routes with custom prefix", () => {
      expect(
        isRouteActive({
          pathName: `${envPath}/runs`,
          to: envPath,
          matchPrefix: `${envPath}/tasks`,
        })
      ).toBe(false);
      expect(
        isRouteActive({
          pathName: `${envPath}/batches/batch_123`,
          to: envPath,
          matchPrefix: `${envPath}/tasks`,
        })
      ).toBe(false);
    });

    it("handles trailing slashes gracefully", () => {
      expect(
        isRouteActive({
          pathName: `${envPath}/tasks/standard/task-1`,
          to: envPath,
          matchPrefix: `${envPath}/tasks/`,
        })
      ).toBe(true);
    });
  });

  describe("custom string array matchPrefix (Tasks & Agents)", () => {
    const tasksPrefixes = [`${envPath}/tasks`, `${envPath}/agents`];

    it("matches Tasks root page via exact to match", () => {
      expect(
        isRouteActive({
          pathName: envPath,
          to: envPath,
          matchPrefix: tasksPrefixes,
        })
      ).toBe(true);
    });

    it("matches task detail routes under /tasks", () => {
      expect(
        isRouteActive({
          pathName: `${envPath}/tasks/standard/my-task`,
          to: envPath,
          matchPrefix: tasksPrefixes,
        })
      ).toBe(true);
      expect(
        isRouteActive({
          pathName: `${envPath}/tasks/scheduled/my-task`,
          to: envPath,
          matchPrefix: tasksPrefixes,
        })
      ).toBe(true);
      expect(
        isRouteActive({
          pathName: `${envPath}/tasks/dashboard`,
          to: envPath,
          matchPrefix: tasksPrefixes,
        })
      ).toBe(true);
    });

    it("matches agent task detail routes under /agents", () => {
      expect(
        isRouteActive({
          pathName: `${envPath}/agents/my-agent`,
          to: envPath,
          matchPrefix: tasksPrefixes,
        })
      ).toBe(true);
    });

    it("does not match sibling sections in the environment", () => {
      expect(
        isRouteActive({
          pathName: `${envPath}/runs`,
          to: envPath,
          matchPrefix: tasksPrefixes,
        })
      ).toBe(false);
      expect(
        isRouteActive({
          pathName: `${envPath}/runs/run_123`,
          to: envPath,
          matchPrefix: tasksPrefixes,
        })
      ).toBe(false);
      expect(
        isRouteActive({
          pathName: `${envPath}/sessions`,
          to: envPath,
          matchPrefix: tasksPrefixes,
        })
      ).toBe(false);
      expect(
        isRouteActive({
          pathName: `${envPath}/webhooks`,
          to: envPath,
          matchPrefix: tasksPrefixes,
        })
      ).toBe(false);
      expect(
        isRouteActive({
          pathName: `${envPath}/deployments`,
          to: envPath,
          matchPrefix: tasksPrefixes,
        })
      ).toBe(false);
      expect(
        isRouteActive({
          pathName: `${envPath}/settings`,
          to: envPath,
          matchPrefix: tasksPrefixes,
        })
      ).toBe(false);
    });
  });
});

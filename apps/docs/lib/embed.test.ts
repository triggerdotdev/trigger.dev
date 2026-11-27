import { describe, expect, it } from "vitest";
import { embedLink, embedPageMessage } from "./embed";

const here = "https://trigger.dev/docs/embed/tasks/overview?project=proj_abc&theme=light";
const dashboard = "https://cloud.trigger.dev";

describe("embedLink", () => {
  it("keeps docs pages in the embed with the project and theme", () => {
    expect(embedLink("/docs/triggering#options", here, dashboard)).toEqual({
      embed: "/embed/triggering?project=proj_abc&theme=light#options",
    });
  });

  it("sends the dashboard to the top window and other sites to a new tab", () => {
    expect(embedLink("https://cloud.trigger.dev/_/runs", here, dashboard)).toEqual({
      target: "_top",
    });
    expect(embedLink("https://github.com/triggerdotdev", here, dashboard)).toEqual({
      target: "_blank",
    });
    expect(embedLink("https://trigger.dev/blog", here, dashboard)).toEqual({ target: "_blank" });
  });

  // Catches: an in-page section link changing the URL without telling the panel (no hashchange).
  it("turns links to a section of the current page into a hash change", () => {
    expect(embedLink("#retries", here, dashboard)).toEqual({ hash: "#retries" });
    expect(embedLink("/docs/tasks/overview#retries", here, dashboard)).toEqual({
      hash: "#retries",
    });
    expect(embedLink(`${here}#retries`, here, dashboard)).toEqual({ hash: "#retries" });
  });

  it("leaves embed links alone, and opens files in a new tab", () => {
    expect(embedLink("#", here, dashboard)).toBeNull();
    expect(embedLink("/docs/embed/queue-concurrency", here, dashboard)).toBeNull();
    expect(embedLink("/docs/tasks/overview.md", here, dashboard)).toEqual({ target: "_blank" });
    expect(embedLink("/docs/images/x.png", here, dashboard)).toEqual({ target: "_blank" });
  });
});

describe("embedPageMessage", () => {
  // Catches: the panel's "Open in new tab" dropping the section the reader was linked to.
  it("keeps the section the reader is on", () => {
    expect(embedPageMessage("Limits", "/limits", "#task-payloads-and-outputs")).toEqual({
      type: "trigger-docs:page",
      title: "Limits",
      path: "/limits#task-payloads-and-outputs",
    });
    expect(embedPageMessage("Limits", "/limits", "").path).toBe("/limits");
  });
});

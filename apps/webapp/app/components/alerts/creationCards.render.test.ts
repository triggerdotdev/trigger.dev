import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import {
  WatchStyleReviewCard,
  AlertCreatedCard,
  type ReviewCardFields,
  type ReviewCardActions,
} from "./creationCards";
import { alertCreatedBlock, type CreatedCardFields } from "./alertCreatedCard";

function wrap(el: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(ShortcutsProvider, null, el)
      )
    )
  );
}

const REVIEW_FIELDS: ReviewCardFields = {
  name: "Queue depth alert",
  conditionSummary: "Queue depth > 100 for 5m",
  scopeLabel: "All",
  behavior: "recurring",
  notifyLabel: "this chat",
};

const REVIEW_ACTIONS: ReviewCardActions = {
  onCreate: () => {},
  onCustomize: () => {},
  onStartOver: () => {},
};

const CREATED_FIELDS: CreatedCardFields = {
  name: "Queue depth alert",
  conditionSummary: "Queue depth > 100 for 5m",
  scopeLabel: "All",
  behavior: "recurring",
  notifyLabel: "this chat",
  expiryLabel: "expires in 24h",
};

describe("WatchStyleReviewCard", () => {
  it("renders Create alert, Customize, and Start over buttons", () => {
    const html = wrap(
      createElement(WatchStyleReviewCard, {
        fields: REVIEW_FIELDS,
        actions: REVIEW_ACTIONS,
      })
    );
    expect(html).toContain("Create alert");
    expect(html).toContain("Customize");
    expect(html).toContain("Start over");
  });

  it("fails when the review card lacks the Customize button", () => {
    const html = wrap(
      createElement(WatchStyleReviewCard, {
        fields: REVIEW_FIELDS,
        actions: REVIEW_ACTIONS,
      })
    );
    expect(html).toContain("Customize");
  });

  it("renders condition summary and scope", () => {
    const html = wrap(
      createElement(WatchStyleReviewCard, {
        fields: REVIEW_FIELDS,
        actions: REVIEW_ACTIONS,
      })
    );
    expect(html).toContain("Queue depth &gt; 100 for 5m");
    expect(html).toContain("All");
  });

  it("renders the environment title", () => {
    const html = wrap(
      createElement(WatchStyleReviewCard, {
        fields: { ...REVIEW_FIELDS, environmentTitle: "Staging" },
        actions: REVIEW_ACTIONS,
      })
    );
    expect(html).toContain("Staging");
    expect(html).not.toContain("Production");
  });
});

describe("AlertCreatedCard", () => {
  it("renders the environment title in the watching row", () => {
    const html = wrap(
      createElement(AlertCreatedCard, {
        block: alertCreatedBlock("a_1", { ...CREATED_FIELDS, environmentTitle: "Staging" }),
      })
    );
    expect(html).toContain("Staging");
    expect(html).not.toContain("Production");
  });

  it("renders the headline with name", () => {
    const html = wrap(
      createElement(AlertCreatedCard, { block: alertCreatedBlock("a_1", CREATED_FIELDS) })
    );
    expect(html).toContain("Queue depth alert is active.");
  });

  it("fails when the success card omits the lifetime line", () => {
    const html = wrap(
      createElement(AlertCreatedCard, { block: alertCreatedBlock("a_1", CREATED_FIELDS) })
    );
    expect(html).toContain("It expires in 24h.");
  });

  it("renders recurring no-expiry lifetime", () => {
    const recurringFields: CreatedCardFields = { ...CREATED_FIELDS, expiryLabel: undefined };
    const html = wrap(
      createElement(AlertCreatedCard, { block: alertCreatedBlock("a_1", recurringFields) })
    );
    expect(html).toContain("It stays active until you turn it off.");
  });

  it("renders notifying line", () => {
    const html = wrap(
      createElement(AlertCreatedCard, { block: alertCreatedBlock("a_1", CREATED_FIELDS) })
    );
    expect(html).toContain("Notifying: this chat.");
  });

  it("ends with a View alert button and no status block", () => {
    const html = wrap(
      createElement(AlertCreatedCard, {
        block: alertCreatedBlock("a_1", CREATED_FIELDS),
        alertDetailPath: "/alerts/a_1",
      })
    );
    expect(html).toContain('href="/alerts/a_1"');
    expect(html).toContain(">View alert<");
    expect(html).not.toContain("Status");
    expect(html).not.toContain("<dl");
  });

  it("formats a custom expiry on the client", () => {
    const expiresAt = "2030-01-02T03:04:05.000Z";
    const block = alertCreatedBlock("a_1", {
      ...CREATED_FIELDS,
      expiryLabel: undefined,
      expiresAt,
    });
    const html = wrap(createElement(AlertCreatedCard, { block }));
    expect(html).toContain(`It expires ${new Date(expiresAt).toLocaleString()}.`);
    expect(html).not.toContain(expiresAt);
  });

  it("renders alert list placement line", () => {
    const html = wrap(
      createElement(AlertCreatedCard, { block: alertCreatedBlock("a_1", CREATED_FIELDS) })
    );
    expect(html).toContain("top of your alerts list");
  });
});

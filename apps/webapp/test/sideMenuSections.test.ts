import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { NewBadge } from "~/components/FeatureBadges";
import { buildSideMenuSections } from "~/components/navigation/sideMenuSections";

const build = (isAdmin: boolean) =>
  buildSideMenuSections({
    organization: { slug: "org" },
    project: { slug: "proj" },
    environment: { slug: "dev" },
    isAdmin,
    alertsConfigured: true,
    featureFlags: {},
    isManagedCloud: false,
  });

describe("buildSideMenuSections alerts placement", () => {
  it("puts Alerts first in Observability, before Logs, with a New badge", () => {
    const sections = build(true);
    const observability = sections.find((s) => s.id === "metrics")!;
    const ids = observability.items.map((i) => i.id);
    expect(ids.indexOf("alerts")).toBe(0);
    expect(ids.indexOf("logs")).toBe(1);

    const alerts = observability.items.find((i) => i.id === "alerts")!;
    expect(isValidElement(alerts.badge) && alerts.badge.type).toBe(NewBadge);

    const manage = sections.find((s) => s.id === "manage")!;
    expect(manage.items.some((i) => i.id === "alerts")).toBe(false);
  });

  it("matches the Alerts item on sub-paths", () => {
    const alerts = build(true)
      .flatMap((s) => s.items)
      .find((i) => i.id === "alerts")!;
    expect(alerts.matchPrefix).toBe(true);
  });

  it("keeps main's Alerts item in Manage when the alerts flag is off", () => {
    const sections = buildSideMenuSections({
      organization: { slug: "org" },
      project: { slug: "proj" },
      environment: { slug: "dev" },
      isAdmin: false,
      alertsConfigured: false,
      featureFlags: { hasQueryAccess: true },
      isManagedCloud: false,
    });
    const observability = sections.find((s) => s.id === "metrics")!;
    expect(observability.items.some((i) => i.id === "alerts")).toBe(false);

    const manage = sections.find((s) => s.id === "manage")!;
    const ids = manage.items.map((i) => i.id);
    expect(ids.indexOf("alerts")).toBe(ids.indexOf("api-keys") + 1);
    const alerts = manage.items.find((i) => i.id === "alerts")!;
    expect(alerts.badge).toBeUndefined();
    expect(alerts.matchPrefix).toBeUndefined();
  });

  it("moves Alerts into Observability when the alerts flag is on", () => {
    const sections = buildSideMenuSections({
      organization: { slug: "org" },
      project: { slug: "proj" },
      environment: { slug: "dev" },
      isAdmin: false,
      alertsConfigured: false,
      featureFlags: { hasQueryAccess: true, alertsEnabled: true },
      isManagedCloud: false,
    });
    const alerts = sections.find((s) => s.id === "metrics")!.items.find((i) => i.id === "alerts")!;
    expect(isValidElement(alerts.badge) && alerts.badge.type).toBe(NewBadge);
    const manage = sections.find((s) => s.id === "manage")!;
    expect(manage.items.some((i) => i.id === "alerts")).toBe(false);
  });

  it("keeps Alerts in Manage after API keys when Observability is hidden", () => {
    const sections = build(false);
    expect(sections.some((s) => s.id === "metrics")).toBe(false);

    const ids = sections.find((s) => s.id === "manage")!.items.map((i) => i.id);
    expect(ids.indexOf("alerts")).toBe(ids.indexOf("api-keys") + 1);
  });
});

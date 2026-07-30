import { describe, expect, it, vi } from "vitest";
import type { UserFromSession } from "~/services/session.server";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";

const PROJECT_ID = "project_1";
const USER_ID = "user_me";
const OTHER_USER_ID = "user_colleague";

function userWithPreference(environmentId: string | undefined): UserFromSession {
  return {
    id: USER_ID,
    dashboardPreferences: {
      currentProjectId: PROJECT_ID,
      projects: environmentId
        ? { [PROJECT_ID]: { currentEnvironment: { id: environmentId } } }
        : {},
    },
  } as unknown as UserFromSession;
}

const myDev = {
  id: "env_my_dev",
  type: "DEVELOPMENT" as const,
  slug: "dev",
  parentEnvironmentId: null,
  orgMember: { userId: USER_ID },
};

const theirDev = {
  id: "env_their_dev",
  type: "DEVELOPMENT" as const,
  slug: "dev",
  parentEnvironmentId: null,
  orgMember: { userId: OTHER_USER_ID },
};

const prod = {
  id: "env_prod",
  type: "PRODUCTION" as const,
  slug: "prod",
  parentEnvironmentId: null,
  orgMember: null,
};

describe("SelectBestEnvironmentPresenter.selectBestEnvironment", () => {
  const presenter = new SelectBestEnvironmentPresenter({} as never);

  it("honours a stored preference that belongs to the user", async () => {
    const result = await presenter.selectBestEnvironment(PROJECT_ID, userWithPreference(myDev.id), [
      theirDev,
      myDev,
      prod,
    ]);

    expect(result).toBe(myDev);
  });

  it("ignores a stored preference pointing at another member's dev environment", async () => {
    const result = await presenter.selectBestEnvironment(
      PROJECT_ID,
      userWithPreference(theirDev.id),
      [theirDev, myDev, prod]
    );

    expect(result).toBe(myDev);
  });

  it("falls back to production when the user has no dev environment of their own", async () => {
    const result = await presenter.selectBestEnvironment(
      PROJECT_ID,
      userWithPreference(theirDev.id),
      [theirDev, prod]
    );

    expect(result).toBe(prod);
  });

  it("returns the user's own dev environment when no preference is stored", async () => {
    const result = await presenter.selectBestEnvironment(
      PROJECT_ID,
      userWithPreference(undefined),
      [theirDev, myDev, prod]
    );

    expect(result).toBe(myDev);
  });
});

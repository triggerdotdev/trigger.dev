/**
 * TEMPORARY — DEVELOPMENT ONLY. DELETE THIS FILE BEFORE MERGING.
 *
 * The project Integrations settings page hides most of its UI behind
 * environment config (a configured GitHub App, a configured Vercel
 * integration) and behind connection state (connected vs. not connected).
 * Locally that leaves almost nothing on screen, which makes it impossible to
 * style the page.
 *
 * When `DEV_REVEAL_ALL` is true, the page and its two panels render every
 * state at once using the placeholder data below. Nothing here is wired to a
 * real integration — the forms still post to their real actions and will fail.
 *
 * To revert: set `DEV_REVEAL_ALL` to false, delete this file, and remove every
 * `devReveal` prop and `DEV_REVEAL_ALL` reference. `rg "DEV_REVEAL_ALL|devReveal"`
 * finds all of them.
 */

import { type ReactNode } from "react";
import { type VercelProjectIntegrationData } from "~/v3/vercel/vercelProjectIntegrationSchema";

export const DEV_REVEAL_ALL = true;

/** Labels a placeholder state so it is obvious it isn't real data. */
export function DevRevealLabel({ children }: { children: ReactNode }) {
  if (!DEV_REVEAL_ALL) return null;

  return (
    <div className="flex items-center gap-2 border-b border-dashed border-amber-500/40 py-2">
      <span className="rounded-[2px] bg-amber-500/15 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wide text-amber-400">
        dev preview
      </span>
      <span className="text-xs text-amber-400/80">{children}</span>
    </div>
  );
}

export const devRevealGitHubInstallations = [
  {
    id: "dev-installation",
    appInstallationId: BigInt(1),
    targetType: "Organization",
    accountHandle: "acme-inc",
    repositories: [
      {
        id: "dev-repo",
        name: "acme-app",
        fullName: "acme-inc/acme-app",
        private: true,
        htmlUrl: "https://github.com/acme-inc/acme-app",
      },
    ],
  },
];

/** Same repo, but public — so the globe/"This repo is public" state is visible too. */
export const devRevealConnectedGitHubRepoPublic = {
  branchTracking: {
    prod: { branch: "main" },
    staging: { branch: "staging" },
  },
  previewDeploymentsEnabled: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  repository: {
    ...devRevealGitHubInstallations[0].repositories[0],
    private: false,
  },
};

export const devRevealConnectedGitHubRepo = {
  branchTracking: {
    prod: { branch: "main" },
    staging: { branch: "staging" },
  },
  previewDeploymentsEnabled: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  repository: devRevealGitHubInstallations[0].repositories[0],
};

const devRevealVercelIntegrationData: VercelProjectIntegrationData = {
  vercelProjectId: "prj_dev",
  vercelProjectName: "acme-app",
  vercelTeamId: "team_dev",
  syncEnvVarsMapping: {},
  onboardingCompleted: true,
  config: {
    atomicBuilds: ["prod"],
    pullEnvVarsBeforeBuild: ["prod", "preview"],
    discoverEnvVars: ["prod"],
    vercelStagingEnvironment: { environmentId: "env_dev", displayName: "staging" },
    autoPromote: true,
  },
};

export const devRevealConnectedVercelProject = {
  id: "dev-vercel-integration",
  vercelProjectId: "prj_dev",
  vercelProjectName: "acme-app",
  vercelTeamId: "team_dev" as string | null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  integrationData: devRevealVercelIntegrationData,
};

export const devRevealVercelCustomEnvironments = [{ id: "env_dev", slug: "staging" }];

import type { ReactNode } from "react";
import { Rocket } from "lucide-react";
import {
  dashboardLink,
  personalizationEnabled,
  productionDashboardOrigin,
} from "@/lib/dashboard-link";
import { DashboardAnchor } from "./dashboard-anchor";

const ENV_VARS = "/_/environment-variables";
const code = "rounded border bg-fd-muted px-1 py-px font-mono text-[0.75rem] text-fd-foreground";
const link = "font-medium text-fd-primary underline-offset-2 hover:underline";

/**
 * "Deploy this example", added after an example page's repo card by lib/remark-deploy-example.ts.
 * `children` is the commands code block, so signed-in readers see their own project ref in it.
 */
export function DeployExample({ folder, children }: { folder: string; children?: ReactNode }) {
  const envVars = personalizationEnabled ? (
    <DashboardAnchor href={`${productionDashboardOrigin}${ENV_VARS}`} className={link}>
      environment variables
    </DashboardAnchor>
  ) : (
    <a href={dashboardLink(ENV_VARS)} className={link}>
      environment variables
    </a>
  );

  return (
    <section
      aria-label="Deploy this example"
      className="not-prose my-6 rounded-lg border border-fd-border bg-fd-card p-4"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-fd-border bg-fd-muted text-fd-primary">
          <Rocket className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[0.9375rem] font-semibold leading-snug text-(--color-text-bright)">
            Deploy this example to your project
          </p>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-fd-muted-foreground">
            Copies <span className={code}>{folder}</span> from GitHub, installs it, and deploys its
            tasks to your project&rsquo;s production environment.
          </p>
        </div>
      </div>
      <div className="[&_figure]:mb-3 [&_figure]:mt-3">{children}</div>
      <p className="text-[0.8125rem] leading-relaxed text-fd-muted-foreground">
        If the example has a <span className={code}>.env.example</span>, set those variables in your
        project&rsquo;s {envVars} before deploying. To run the tasks on your machine instead, use{" "}
        <span className={code}>dev</span> in place of <span className={code}>deploy</span>.
      </p>
    </section>
  );
}

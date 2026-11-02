import type { BillingAddOns, BillingCreditType } from "@trigger.dev/billing";
import { BillingUsageView } from "~/components/billing/usage/BillingUsageView";
import { PageContainer } from "~/components/layout/AppLayout";
import { useSearchParams } from "~/hooks/useSearchParam";
import type {
  MonthlyUsageLine,
  MonthlyUsageView,
  ProjectUsageLine,
  ProjectUsageView,
} from "~/utils/billingUsageBreakdown";
import { daysInUsageMonth, resolveUsageMonth, usageMonths } from "~/utils/billingUsagePeriod";
import { ComponentNames } from "../storybook/StoryKit";

const NOW = new Date(Date.UTC(2026, 9, 16));
const MONTHS = usageMonths(NOW);
const USD: BillingCreditType = {
  id: "usd",
  name: "USD (cents)",
  currency: { code: "USD", minorUnitsPerUnit: 100 },
};
const RUN_CENTS = 0.0025;
const MACHINES: [string, number, number][] = [
  ["micro", 1.6875e-6, 40],
  ["small-1x", 3.375e-6, 520],
  ["small-2x", 6.75e-6, 160],
  ["medium-1x", 8.5e-6, 130],
  ["large-1x", 3.4e-5, 9],
];
const REGIONS: [string, number][] = [
  ["us-east-1", 1],
  ["eu-central-1", 0.42],
];
const ENVIRONMENTS: [string, number][] = [
  ["production", 1],
  ["staging", 0.22],
  ["preview", 0.09],
];
const PROJECTS = [
  { id: "proj_wkr8f2", slug: "api-workers", name: "api-workers", weight: 0.46 },
  { id: "proj_eml3k9", slug: "email-pipeline", name: "email-pipeline", weight: 0.27 },
  { id: "proj_dsn71q", slug: "data-sync", name: "data-sync", weight: 0.19 },
  { id: "proj_agt05m", slug: "ai-agents", name: "ai-agents", weight: 0.08 },
  { id: "proj_idle00", slug: "idle", name: "idle-project", weight: 0 },
];

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function elapsedDays(month: string) {
  const days = daysInUsageMonth(month);
  return month === MONTHS[0] ? days.slice(0, NOW.getUTCDate()) : days;
}

function monthlyUsage(month: string): MonthlyUsageView {
  const next = random(Number(month.replace("-", "")));
  const hasDimensions = month >= "2026-10";
  const scale = elapsedDays(month).length / 30;
  const lines: MonthlyUsageLine[] = [];

  for (const [machine, centsPerMs, hours] of MACHINES) {
    for (const [region, regionWeight] of hasDimensions ? REGIONS : [["", 1] as [string, number]]) {
      for (const [environment, environmentWeight] of hasDimensions
        ? ENVIRONMENTS
        : [["", 1] as [string, number]]) {
        const quantity = Math.round(
          hours * regionWeight * environmentWeight * scale * (0.7 + next() * 0.6) * 3_600_000
        );
        lines.push({
          usageType: "compute",
          machinePreset: machine,
          region: region || null,
          environmentType: environment || null,
          quantity,
          unitPrice: centsPerMs,
          total: quantity * centsPerMs,
        });
      }
    }
  }
  for (const [region, regionWeight] of hasDimensions ? REGIONS : [["", 1] as [string, number]]) {
    for (const [environment, environmentWeight] of hasDimensions
      ? [...ENVIRONMENTS, ["development", 0.45] as [string, number]]
      : [["", 1] as [string, number]]) {
      const quantity = Math.round(410_000 * regionWeight * environmentWeight * scale);
      lines.push({
        usageType: "runs",
        machinePreset: null,
        region: region || null,
        environmentType: environment || null,
        quantity,
        unitPrice: RUN_CENTS,
        total: quantity * RUN_CENTS,
      });
    }
  }

  const total = lines.reduce((sum, line) => sum + line.total, 0);
  const days = elapsedDays(month);
  const weights = days.map(() => 0.6 + next() * 0.8);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

  return {
    organizationId: "org_story",
    fetchedAt: NOW.toISOString(),
    month,
    isCurrentMonth: month === MONTHS[0],
    creditType: USD,
    total,
    creditsApplied: Math.min(total, 1_000),
    creditsForUsage: 194 + 1815,
    credits: [
      {
        id: "free",
        name: "Free monthly credit",
        kind: "credit",
        source: "plan",
        amount: 194,
        applied: 80,
        forUsage: 194,
        startsAt: "2026-10-01T00:00:00Z",
        endsAt: "2026-10-20T00:00:00Z",
      },
      {
        id: "pro",
        name: "Pro monthly credit",
        kind: "credit",
        source: "plan",
        amount: 1815,
        applied: Math.max(0, Math.min(total, 1_000) - 80),
        forUsage: 1815,
        startsAt: "2026-10-20T00:00:00Z",
        endsAt: "2026-11-01T00:00:00Z",
      },
      {
        id: "unused",
        name: "Unused time on 3 × 50 concurrent runs after 21 Oct 2026",
        kind: "credit",
        source: "proration",
        amount: 1008,
        applied: 0,
        forUsage: 0,
        startsAt: "2026-10-21T14:00:00Z",
        endsAt: "2031-10-21T14:00:00Z",
      },
    ],
    days: daysInUsageMonth(month).map((date, index) => ({
      date,
      total: index < days.length ? (total * weights[index]) / weightSum : 0,
    })),
    lines,
  };
}

function projectUsage(month: string): ProjectUsageView {
  const next = random(Number(month.replace("-", "")) + 7);
  const usage = monthlyUsage(month);
  const lines: ProjectUsageLine[] = [];
  for (const project of PROJECTS) {
    if (project.weight === 0) continue;
    for (const line of usage.lines.filter((entry) => entry.usageType === "compute")) {
      lines.push({
        projectId: project.id,
        machinePreset: line.machinePreset,
        region: line.region,
        environmentType: line.environmentType,
        computeMs: Math.round(line.quantity * project.weight * (0.8 + next() * 0.4)),
        runs: Math.round((line.quantity / 9_000) * project.weight),
      });
    }
  }

  const days = elapsedDays(month);
  const shares = PROJECTS.map(() => {
    const weights = days.map(() => 0.6 + next() * 0.8);
    const sum = weights.reduce((total, weight) => total + weight, 0);
    return weights.map((weight) => weight / sum);
  });
  const totalsFor = (projectId: string) =>
    lines
      .filter((line) => line.projectId === projectId)
      .reduce(
        (total, line) => ({
          computeMs: total.computeMs + line.computeMs,
          runs: total.runs + line.runs,
        }),
        { computeMs: 0, runs: 0 }
      );

  return {
    month,
    organizationId: "org_story",
    fetchedAt: NOW.toISOString(),
    isCurrentMonth: usage.isCurrentMonth,
    truncated: false,
    projectIds: PROJECTS.filter((project) => project.weight > 0).map((project) => project.id),
    projects: PROJECTS.map(({ id, slug, name }) => ({
      id,
      slug,
      name,
      externalRef: id,
      deleted: name === "idle-project",
    })),
    days: daysInUsageMonth(month).map((date, index) => ({
      date,
      projects:
        index < days.length
          ? PROJECTS.filter((project) => project.weight > 0).map((project, projectIndex) => {
              const total = totalsFor(project.id);
              const share = shares[projectIndex][index];
              return {
                projectId: project.id,
                computeMs: Math.round(total.computeMs * share),
                runs: Math.round(total.runs * share),
              };
            })
          : [],
    })),
    lines,
  };
}

function addOns(month: string): BillingAddOns {
  return {
    organizationId: "org_story",
    fetchedAt: NOW.toISOString(),
    month,
    creditType: USD,
    invoiceDate: "2026-11-01",
    next: [
      {
        productId: "conc",
        name: "Additional Concurrency",
        quantity: 2,
        unitPrice: 1000,
        total: 2000,
      },
      { productId: "seats", name: "Additional Seats", quantity: 1, unitPrice: 2000, total: 2000 },
    ],
    charged: [
      { name: "Additional Concurrency", date: "2026-10-20", total: 1088.71 },
      {
        name: "Unused time on 3 × 50 concurrent runs after 21 Oct 2026",
        date: "2026-10-21",
        total: -1008,
      },
    ],
  };
}

export default function Story() {
  const { value } = useSearchParams();
  const month = resolveUsageMonth(value("month"), MONTHS);

  return (
    <PageContainer>
      <div className="px-4 pt-4">
        <ComponentNames
          names={["BillingUsageView.tsx", "UsageTab.tsx", "ProjectUsageTab.tsx", "AddOnsTab.tsx"]}
        />
      </div>
      <BillingUsageView
        organizationSlug="storybook"
        months={MONTHS}
        month={month}
        usage={{ ok: true, value: monthlyUsage(month) }}
        projectUsage={{ ok: true, value: projectUsage(month) }}
        addOns={{ ok: true, value: addOns(month) }}
        limits={{
          includedUsageDollars: 50,
          billingLimitDollars: 300,
          hasBillingLimit: true,
          billingLimitsPath: "#",
        }}
      />
    </PageContainer>
  );
}

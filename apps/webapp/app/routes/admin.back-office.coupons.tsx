import { Form } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useState } from "react";
import { redirect, typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import {
  ApplyCouponDialog,
  type ApplyCouponTarget,
} from "~/components/admin/ApplyCouponDialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/primitives/Accordion";
import { Button } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { logger } from "~/services/logger.server";
import {
  applyCouponDeal,
  getCouponDiagnostics,
  listCouponDeals,
  refreshCouponDeals,
  resolveCouponCustomer,
} from "~/services/platform.v3.server";
import { requireUser } from "~/services/session.server";

type CouponDeal = {
  key: string;
  label: string;
  category: string;
  couponId: string;
};

type CouponMatch = {
  orgId: string;
  slug: string;
  title: string;
  planCode: string | null;
  subscriptionId: string | null;
  activeDealKey: string | null;
  stripeCustomerId: string;
  stripeCustomerEmail: string;
  primaryUserEmail: string | null;
};

type CouponDiagnostic = {
  id: string;
  name: string | null;
  metadata: Record<string, string>;
};

type LoaderData = {
  email: string | null;
  deals: CouponDeal[];
  matches: CouponMatch[] | null;
  diagnostics: CouponDiagnostic[];
  appliedDealKey: string | null;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }

  const url = new URL(request.url);
  const emailParam = url.searchParams.get("email");
  const email = emailParam && emailParam.trim().length > 0 ? emailParam.trim() : null;
  const appliedDealKey = url.searchParams.get("applied");

  const [dealsResult, diagnostics] = await Promise.all([
    listCouponDeals(),
    safeDiagnostics(),
  ]);

  let matches: CouponMatch[] | null = null;
  if (email) {
    const resolveResult = await resolveCouponCustomer(email);
    matches = resolveResult.matches as CouponMatch[];
  }

  const data: LoaderData = {
    email,
    deals: dealsResult.deals as CouponDeal[],
    matches,
    diagnostics,
    appliedDealKey,
  };
  return typedjson(data);
}

// Diagnostics is a nice-to-have panel; if billing has a transient issue with
// it, the rest of the page should still work. The other calls remain hard
// failures because the page is useless without them.
async function safeDiagnostics(): Promise<CouponDiagnostic[]> {
  try {
    const result = await getCouponDiagnostics();
    return result.unregisteredCoupons as CouponDiagnostic[];
  } catch (error) {
    logger.warn("Coupon diagnostics fetch failed; rendering page without panel", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

const ApplySchema = z.object({
  intent: z.literal("apply"),
  orgId: z.string().min(1),
  dealKey: z.string().min(1),
});

const RefreshSchema = z.object({
  intent: z.literal("refresh"),
});

type ActionResponse =
  | {
      error: string;
      code?: string;
      currentDealKey?: string | null;
    }
  | undefined;

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }

  const payload = Object.fromEntries(await request.formData());

  const refreshAttempt = RefreshSchema.safeParse(payload);
  if (refreshAttempt.success) {
    try {
      await refreshCouponDeals();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh deals.";
      return typedjson<ActionResponse>({ error: message }, { status: 500 });
    }

    const url = new URL(request.url);
    return redirect(`${url.pathname}${url.search}`);
  }

  const applyAttempt = ApplySchema.safeParse(payload);
  if (applyAttempt.success) {
    const { orgId, dealKey } = applyAttempt.data;

    try {
      const result = await applyCouponDeal({ orgId, dealKey });
      if (!result.success) {
        return typedjson<ActionResponse>(
          {
            error: result.error ?? "Failed to apply coupon deal.",
            code: result.code,
            currentDealKey: result.currentDealKey ?? null,
          },
          { status: 400 }
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to apply coupon deal.";
      return typedjson<ActionResponse>({ error: message }, { status: 500 });
    }

    const url = new URL(request.url);
    const search = new URLSearchParams(url.search);
    search.set("applied", dealKey);
    return redirect(`${url.pathname}?${search.toString()}`);
  }

  return typedjson<ActionResponse>(
    { error: "Unrecognized form submission." },
    { status: 400 }
  );
}

function groupDealsByCategory(deals: CouponDeal[]): Array<[string, CouponDeal[]]> {
  const groups = new Map<string, CouponDeal[]>();
  for (const deal of deals) {
    const existing = groups.get(deal.category);
    if (existing) {
      existing.push(deal);
    } else {
      groups.set(deal.category, [deal]);
    }
  }
  return Array.from(groups.entries());
}

export default function CouponsPage() {
  const { email, deals, matches, diagnostics, appliedDealKey } =
    useTypedLoaderData<typeof loader>();
  const actionData = useTypedActionData<typeof action>();

  const dealsByKey = new Map(deals.map((d) => [d.key, d]));
  const dealGroups = groupDealsByCategory(deals);

  const [dialogTarget, setDialogTarget] = useState<ApplyCouponTarget | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const openDialog = (target: ApplyCouponTarget) => {
    setDialogTarget(target);
    setDialogOpen(true);
  };

  const appliedDeal = appliedDealKey ? dealsByKey.get(appliedDealKey) : null;

  return (
    <div className="flex flex-col gap-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Header1>Coupon Deals</Header1>
          <Paragraph variant="small" className="text-text-dimmed max-w-prose">
            Apply a Stripe-tagged coupon to a customer's subscription. Lookup is
            by Stripe customer email — often different from the user's
            Trigger.dev email. Catalog is built from coupons in Stripe whose
            metadata carries{" "}
            <code className="rounded bg-charcoal-700 px-1">trigger_deal_key</code>.
          </Paragraph>
        </div>
        <Form method="post" reloadDocument>
          <input type="hidden" name="intent" value="refresh" />
          <SimpleTooltip
            button={
              <Button type="submit" variant="tertiary/small">
                Refresh deals
              </Button>
            }
            content="Pull the latest tagged coupons from Stripe."
          />
        </Form>
      </div>

      {appliedDeal && (
        <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2">
          <Paragraph variant="small" className="text-green-500">
            Applied: {appliedDeal.label}.
          </Paragraph>
        </div>
      )}

      {actionData && "error" in actionData && actionData.error && (
        <div className="rounded-md border border-red-600/40 bg-red-600/10 px-3 py-2">
          <Paragraph variant="small" className="text-red-500">
            {actionData.error}
            {actionData.code === "already_applied" && actionData.currentDealKey
              ? ` (currently has: ${
                  dealsByKey.get(actionData.currentDealKey)?.label ??
                  actionData.currentDealKey
                })`
              : null}
          </Paragraph>
        </div>
      )}

      <Form method="get" className="flex items-end gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label>Stripe customer email</Label>
          <Input
            type="email"
            name="email"
            defaultValue={email ?? ""}
            placeholder="customer@example.com"
            autoFocus={!email}
          />
          <Hint>
            This is the email on the Stripe customer record, not necessarily the
            user's Trigger.dev email.
          </Hint>
        </div>
        <Button type="submit" variant="primary/medium">
          Find orgs
        </Button>
      </Form>

      {diagnostics.length > 0 && (
        <Accordion type="single" collapsible>
          <AccordionItem value="diagnostics">
            <AccordionTrigger>
              {diagnostics.length} Stripe coupon{diagnostics.length === 1 ? "" : "s"} aren&apos;t
              tagged as deals
            </AccordionTrigger>
            <AccordionContent>
              <Paragraph variant="small" className="text-text-dimmed pb-2">
                These coupons are valid in Stripe but missing the{" "}
                <code className="rounded bg-charcoal-700 px-1">trigger_deal_key</code>{" "}
                metadata field, so they don&apos;t appear in the apply controls
                below. Common causes: typo in the metadata field name, or the
                coupon was never tagged.
              </Paragraph>
              <ul className="flex flex-col gap-1 text-sm">
                {diagnostics.map((c) => (
                  <li key={c.id} className="font-mono text-text-dimmed">
                    {c.id}
                    {c.name ? ` — ${c.name}` : ""}
                    {Object.keys(c.metadata).length > 0 ? (
                      <span className="text-text-dimmed/70">
                        {" "}
                        · {JSON.stringify(c.metadata)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}

      {matches === null ? (
        <Paragraph variant="small" className="text-text-dimmed">
          Enter a Stripe customer email above to find matching Trigger.dev orgs.
        </Paragraph>
      ) : matches.length === 0 ? (
        <Paragraph variant="base">No Trigger.dev orgs found for this Stripe email.</Paragraph>
      ) : (
        <>
          {matches.length > 1 && (
            <div className="rounded-md border border-amber-600/40 bg-amber-600/10 px-3 py-2">
              <Paragraph variant="small" className="text-amber-500">
                Multiple Stripe customers share this email. Verify the org by
                Stripe customer ID before applying.
              </Paragraph>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Header2>{matches.length} match{matches.length === 1 ? "" : "es"}</Header2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Org</TableHeaderCell>
                  <TableHeaderCell>Stripe customer</TableHeaderCell>
                  <TableHeaderCell>Trigger.dev user</TableHeaderCell>
                  <TableHeaderCell>Plan</TableHeaderCell>
                  <TableHeaderCell>Active deal</TableHeaderCell>
                  <TableHeaderCell>Apply</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matches.map((match) => {
                  const activeDeal = match.activeDealKey
                    ? dealsByKey.get(match.activeDealKey)
                    : null;
                  const isFree = match.subscriptionId === null;
                  const hasActive = match.activeDealKey !== null;
                  const disabledReason = isFree
                    ? "Org is on free plan — no subscription to discount."
                    : hasActive
                    ? `Already has: ${activeDeal?.label ?? match.activeDealKey}`
                    : null;

                  return (
                    <TableRow key={match.orgId}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{match.title}</span>
                          <span className="text-text-dimmed text-xs">
                            <CopyableText value={match.slug} />
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <CopyableText value={match.stripeCustomerId} />
                          <span className="text-text-dimmed text-xs">
                            {match.stripeCustomerEmail}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>{match.primaryUserEmail ?? "—"}</TableCell>
                      <TableCell>{match.planCode ?? "Free"}</TableCell>
                      <TableCell>{activeDeal?.label ?? "None"}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-2">
                          {dealGroups.map(([category, dealsInCategory]) => (
                            <div key={category} className="flex flex-col gap-1">
                              <span className="text-text-dimmed text-xs uppercase tracking-wide">
                                {category}
                              </span>
                              <div className="flex flex-wrap gap-1">
                                {dealsInCategory.map((deal) => {
                                  const button = (
                                    <Button
                                      type="button"
                                      variant="tertiary/small"
                                      disabled={disabledReason !== null}
                                      onClick={() =>
                                        openDialog({
                                          orgId: match.orgId,
                                          orgSlug: match.slug,
                                          orgTitle: match.title,
                                          planCode: match.planCode,
                                          subscriptionId: match.subscriptionId,
                                          stripeCustomerId: match.stripeCustomerId,
                                          stripeCustomerEmail: match.stripeCustomerEmail,
                                          dealKey: deal.key,
                                          dealLabel: deal.label,
                                          dealCategory: deal.category,
                                        })
                                      }
                                    >
                                      {deal.label}
                                    </Button>
                                  );
                                  return disabledReason ? (
                                    <SimpleTooltip
                                      key={deal.key}
                                      button={button}
                                      content={disabledReason}
                                    />
                                  ) : (
                                    <span key={deal.key}>{button}</span>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <ApplyCouponDialog
        target={dialogTarget}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}

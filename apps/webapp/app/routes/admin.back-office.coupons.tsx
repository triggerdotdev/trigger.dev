import { Form } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import { redirect, typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import {
  ApplyCouponDialog,
  type ApplyCouponTarget,
} from "~/components/admin/ApplyCouponDialog";
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
import {
  applyCouponDeal,
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

type LoaderData = {
  email: string | null;
  deals: CouponDeal[];
  matches: CouponMatch[] | null;
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

  const dealsResult = await listCouponDeals();

  let matches: CouponMatch[] | null = null;
  if (email) {
    const resolveResult = await resolveCouponCustomer(email);
    matches = resolveResult.matches as CouponMatch[];
  }

  const data: LoaderData = {
    email,
    deals: dealsResult.deals as CouponDeal[],
    matches,
    appliedDealKey,
  };
  return typedjson(data);
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
        // Cast to read `code` and `currentDealKey` from the wire body. The
        // platform's generic ErrorSchema currently strips these to `error`
        // only, so they arrive as undefined for now; the cast keeps the route
        // forward-compatible with a future schema loosening that preserves
        // them, at which point the precise UI messages will start rendering
        // automatically.
        const err = result as {
          success: false;
          error: string;
          code?: string;
          currentDealKey?: string;
        };
        return typedjson<ActionResponse>(
          {
            error: err.error,
            code: err.code,
            currentDealKey: err.currentDealKey ?? null,
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
  const { email, deals, matches, appliedDealKey } =
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

  // Close the dialog after a successful apply: the action redirects with
  // ?applied=<dealKey>, the loader echoes that as appliedDealKey, and we
  // dismiss the modal so the success banner underneath is visible.
  useEffect(() => {
    if (appliedDealKey) setDialogOpen(false);
  }, [appliedDealKey]);

  const appliedDeal = appliedDealKey ? dealsByKey.get(appliedDealKey) : null;

  return (
    <div className="flex flex-col gap-6 py-4">
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

      <Form method="get" className="flex flex-col gap-1">
        <Label>Stripe customer email</Label>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <Input
              type="email"
              name="email"
              defaultValue={email ?? ""}
              placeholder="customer@example.com"
              autoFocus={!email}
            />
          </div>
          <Button type="submit" variant="primary/medium">
            Find orgs
          </Button>
        </div>
        <Hint>
          This is the email on the Stripe customer record, not necessarily the
          user's Trigger.dev email.
        </Hint>
      </Form>

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

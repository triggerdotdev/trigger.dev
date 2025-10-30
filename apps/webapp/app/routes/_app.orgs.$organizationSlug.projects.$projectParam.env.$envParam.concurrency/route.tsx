import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { EnvelopeIcon, PlusIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useActionData, useNavigation, type MetaFunction } from "@remix-run/react";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { InputNumberStepper } from "~/components/primitives/InputNumberStepper";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import {
  ManageConcurrencyPresenter,
  type ConcurrencyResult,
  type EnvironmentWithConcurrency,
} from "~/presenters/v3/ManageConcurrencyPresenter.server";
import { getPlans } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import { formatCurrency, formatNumber } from "~/utils/numberFormatter";
import { concurrencyPath, EnvironmentParamSchema, v3BillingPath } from "~/utils/pathBuilder";
import { SetConcurrencyAddOnService } from "~/v3/services/setConcurrencyAddOn.server";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { SpinnerWhite } from "~/components/primitives/Spinner";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Manage concurrency | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const presenter = new ManageConcurrencyPresenter();
  const [error, result] = await tryCatch(
    presenter.call({
      userId: userId,
      projectId: project.id,
      organizationId: project.organizationId,
    })
  );

  if (error) {
    throw new Response(undefined, {
      status: 400,
      statusText: error.message,
    });
  }

  const plans = await tryCatch(getPlans());
  if (!plans) {
    throw new Response(null, { status: 404, statusText: "Plans not found" });
  }

  return typedjson(result);
};

const FormSchema = z.object({
  action: z.enum(["purchase", "quota-increase"]),
  amount: z.coerce.number().min(1, "Amount must be greater than 0"),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  const redirectPath = concurrencyPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam }
  );

  if (!project) {
    throw redirectWithErrorMessage(redirectPath, request, "Project not found");
  }

  const formData = await request.formData();
  const submission = parse(formData, { schema: FormSchema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  const service = new SetConcurrencyAddOnService();
  const [error, result] = await tryCatch(
    service.call({
      userId,
      projectId: project.id,
      organizationId: project.organizationId,
      action: submission.value.action,
      amount: submission.value.amount,
    })
  );

  if (error) {
    submission.error.amount = [error instanceof Error ? error.message : "Unknown error"];
    return json(submission);
  }

  if (!result.success) {
    submission.error.amount = [result.error];
    return json(submission);
  }

  return redirectWithSuccessMessage(redirectPath, request, "Concurrency updated successfully");
};

export default function Page() {
  const {
    canAddConcurrency,
    extraConcurrency,
    extraAllocatedConcurrency,
    extraUnallocatedConcurrency,
    environments,
    concurrencyPricing,
    maxQuota,
  } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Concurrency" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              {environments.map((environment) => (
                <Property.Item key={environment.id}>
                  <Property.Label>
                    {environment.type}{" "}
                    {environment.branchName ? ` (${environment.branchName})` : ""}
                  </Property.Label>
                  <Property.Value>{environment.id}</Property.Value>
                </Property.Item>
              ))}
            </Property.Table>
          </AdminDebugTooltip>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <MainHorizontallyCenteredContainer>
          {canAddConcurrency ? (
            <Upgradable
              canAddConcurrency={canAddConcurrency}
              extraConcurrency={extraConcurrency}
              extraAllocatedConcurrency={extraAllocatedConcurrency}
              extraUnallocatedConcurrency={extraUnallocatedConcurrency}
              environments={environments}
              concurrencyPricing={concurrencyPricing}
              maxQuota={maxQuota}
            />
          ) : (
            <NotUpgradable environments={environments} />
          )}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}

function Upgradable({
  canAddConcurrency,
  extraConcurrency,
  extraAllocatedConcurrency,
  extraUnallocatedConcurrency,
  environments,
  concurrencyPricing,
  maxQuota,
}: ConcurrencyResult) {
  const organization = useOrganization();

  return (
    <div className="flex flex-col gap-3">
      <div className="border-b border-grid-dimmed pb-1">
        <Header2>Your concurrency</Header2>
      </div>
      <Paragraph variant="small">
        Concurrency limits determine how many runs you can execute at the same time. You can add
        extra concurrency to your organization which you can allocate to environments in your
        projects.
      </Paragraph>
      <div className="mt-3 flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center first-letter:pb-1">
            <Header3 className="grow">Extra concurrency</Header3>
            <PurchaseConcurrencyModal
              concurrencyPricing={concurrencyPricing}
              extraConcurrency={extraConcurrency}
              maxQuota={maxQuota}
            />
          </div>
          <Table>
            <TableBody>
              <TableRow>
                <TableCell className="pl-0 text-text-bright">Extra concurrency purchased</TableCell>
                <TableCell alignment="right" className="text-text-bright">
                  {extraConcurrency}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Allocated concurrency</TableCell>
                <TableCell alignment="right" className="text-text-bright">
                  {extraAllocatedConcurrency}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Unallocated concurrency</TableCell>
                <TableCell
                  alignment="right"
                  className={extraUnallocatedConcurrency > 0 ? "text-success" : "text-text-bright"}
                >
                  {extraUnallocatedConcurrency}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center pb-1">
            <Header3 className="grow">Concurrency allocation</Header3>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className="pl-0">Environment</TableHeaderCell>
                <TableHeaderCell alignment="right">
                  <span className="flex items-center justify-end gap-x-1">
                    Included{" "}
                    <InfoIconTooltip content="This is the included concurrency based on your plan." />
                  </span>
                </TableHeaderCell>
                <TableHeaderCell alignment="right">Extra concurrency</TableHeaderCell>
                <TableHeaderCell alignment="right">Total</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {environments.map((environment) => (
                <TableRow key={environment.id}>
                  <TableCell className="pl-0">
                    <EnvironmentCombo environment={environment} />
                  </TableCell>
                  <TableCell alignment="right">{environment.planConcurrencyLimit}</TableCell>
                  <TableCell alignment="right" className="text-text-bright">
                    <div className="flex items-center justify-end">
                      <Input
                        type="number"
                        variant="secondary-small"
                        className="text-right"
                        containerClassName="w-16 bg-transparent"
                        fullWidth={false}
                        defaultValue={Math.max(
                          0,
                          environment.maximumConcurrencyLimit - environment.planConcurrencyLimit
                        )}
                        min="0"
                      />
                    </div>
                  </TableCell>
                  <TableCell alignment="right">{environment.maximumConcurrencyLimit}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function NotUpgradable({ environments }: { environments: EnvironmentWithConcurrency[] }) {
  const { isManagedCloud } = useFeatures();
  const plan = useCurrentPlan();
  const organization = useOrganization();

  return (
    <div className="flex flex-col gap-3">
      <div className="border-b border-grid-dimmed pb-1">
        <Header2>Your concurrency</Header2>
      </div>
      {isManagedCloud ? (
        <>
          <Paragraph variant="small">
            Concurrency limits determine how many runs you can execute at the same time. You can
            upgrade your plan to get more concurrency. You are currently on the{" "}
            {plan?.v3Subscription?.plan?.title ?? "Free"} plan.
          </Paragraph>
          <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
            Upgrade for more concurrency
          </LinkButton>
        </>
      ) : null}
      <div className="mt-3 flex flex-col gap-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell className="pl-0">Environment</TableHeaderCell>
              <TableHeaderCell alignment="right">Concurrency limit</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {environments.map((environment) => (
              <TableRow key={environment.id}>
                <TableCell className="pl-0">
                  <EnvironmentCombo environment={environment} />
                </TableCell>
                <TableCell alignment="right">{environment.maximumConcurrencyLimit}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function PurchaseConcurrencyModal({
  concurrencyPricing,
  extraConcurrency,
  maxQuota,
}: {
  concurrencyPricing: {
    stepSize: number;
    centsPerStep: number;
  };
  extraConcurrency: number;
  maxQuota: number;
}) {
  const lastSubmission = useActionData();
  const [form, { amount }] = useForm({
    id: "purchase-concurrency",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: FormSchema });
    },
    shouldRevalidate: "onSubmit",
  });

  const [amountValue, setAmountValue] = useState(0);
  const navigation = useNavigation();
  console.log(navigation);
  const isLoading = navigation.state !== "idle" && navigation.formMethod === "POST";

  const maximum = maxQuota - extraConcurrency;
  const isAboveMaxQuota = amountValue > maximum;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="primary/small" LeadingIcon={PlusIcon}>
          Purchase extra concurrency
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>Purchase extra concurrency</DialogHeader>
        <Form method="post" {...form.props}>
          <div className="flex flex-col gap-4 pt-2">
            <Paragraph variant="base/bright" spacing>
              You can purchase bundles of {concurrencyPricing.stepSize} concurrency for{" "}
              {formatCurrency(concurrencyPricing.centsPerStep / 100, false)}/month. You’ll be billed
              monthly, with changes available after a full billing cycle.
            </Paragraph>
            <Fieldset>
              <InputGroup fullWidth>
                <Label htmlFor="amount" className="text-text-dimmed">
                  Extra concurrency to purchase
                </Label>
                <InputNumberStepper
                  {...conform.input(amount, { type: "number" })}
                  step={concurrencyPricing.stepSize}
                  min={0}
                  value={amountValue}
                  onChange={(e) => setAmountValue(Number(e.target.value))}
                  disabled={isLoading}
                />
                <FormError id={amount.errorId}>{amount.error}</FormError>
                <FormError>{form.error}</FormError>
              </InputGroup>
            </Fieldset>
            {isAboveMaxQuota ? (
              <div className="flex flex-col pb-3">
                <Paragraph variant="small" className="text-warning">
                  Your Org’s total would be {formatNumber(extraConcurrency + amountValue)}{" "}
                  concurrency. Send us a request to purchase {formatNumber(amountValue - maximum)}{" "}
                  more, or reduce the amount to buy more today.
                </Paragraph>
              </div>
            ) : (
              <div className="flex flex-col pb-3">
                <div className="grid grid-cols-2 border-b border-grid-dimmed pb-1">
                  <Header3 className="font-normal text-text-dimmed">Summary</Header3>
                  <Header3 className="justify-self-end font-normal text-text-dimmed">Total</Header3>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className="pb-0 font-normal">{amountValue}</Header3>
                  <Header3 className="justify-self-end font-normal">
                    {formatCurrency(
                      (amountValue * concurrencyPricing.centsPerStep) /
                        concurrencyPricing.stepSize /
                        100,
                      false
                    )}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({amountValue / concurrencyPricing.stepSize} bundles @{" "}
                    {formatCurrency(concurrencyPricing.centsPerStep / 100, false)}/mth)
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
              </div>
            )}
          </div>
          <FormButtons
            confirmButton={
              isAboveMaxQuota ? (
                <>
                  <input type="hidden" name="action" value="quota-increase" />
                  <Button
                    LeadingIcon={isLoading ? SpinnerWhite : EnvelopeIcon}
                    variant="primary/medium"
                    type="submit"
                    disabled={isLoading}
                  >
                    {`Send request for ${formatNumber(amountValue - maximum)}`}
                  </Button>
                </>
              ) : (
                <>
                  <input type="hidden" name="action" value="purchase" />
                  <Button
                    variant="primary/medium"
                    type="submit"
                    disabled={isLoading}
                    LeadingIcon={isLoading ? SpinnerWhite : undefined}
                  >
                    Purchase
                  </Button>
                </>
              )
            }
            cancelButton={
              <DialogClose asChild>
                <Button variant="tertiary/medium" disabled={isLoading}>
                  Cancel
                </Button>
              </DialogClose>
            }
          />
        </Form>
      </DialogContent>
    </Dialog>
  );
}

import { conform, useFieldList, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  EnvelopeIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  PlusIcon,
} from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import {
  Form,
  useActionData,
  useNavigate,
  useNavigation,
  useSearchParams,
  type MetaFunction,
} from "@remix-run/react";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { useEffect, useState } from "react";
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
import { cn } from "~/utils/cn";
import { logger } from "~/services/logger.server";
import { AllocateConcurrencyService } from "~/v3/services/allocateConcurrency.server";

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

const FormSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["purchase"]),
    amount: z.coerce.number().min(0, "Amount must be 0 or more"),
  }),
  z.object({
    action: z.enum(["quota-increase"]),
    amount: z.coerce.number().min(1, "Amount must be greater than 0"),
  }),
  z.object({
    action: z.enum(["allocate"]),
    // It will only update environments that are passed in
    environments: z.array(
      z.object({
        id: z.string(),
        amount: z.coerce.number().min(0, "Amount must be 0 or more"),
      })
    ),
  }),
]);

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

  if (submission.value.action === "allocate") {
    const allocate = new AllocateConcurrencyService();
    const [error, result] = await tryCatch(
      allocate.call({
        userId,
        projectId: project.id,
        organizationId: project.organizationId,
        environments: submission.value.environments,
      })
    );

    if (error) {
      submission.error.environments = [error instanceof Error ? error.message : "Unknown error"];
      return json(submission);
    }

    if (!result.success) {
      submission.error.environments = [result.error];
      return json(submission);
    }

    return redirectWithSuccessMessage(
      `${redirectPath}?success=true`,
      request,
      "Concurrency allocated successfully"
    );
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

  return redirectWithSuccessMessage(
    `${redirectPath}?success=true`,
    request,
    submission.value.action === "purchase"
      ? "Concurrency updated successfully"
      : "Requested extra concurrency, we'll get back to you soon."
  );
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
      <PageBody scrollable={true}>
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

function initialAllocation(environments: ConcurrencyResult["environments"]) {
  return new Map<string, number>(
    environments
      .filter((e) => e.type !== "DEVELOPMENT")
      .map((e) => [e.id, Math.max(0, e.maximumConcurrencyLimit - e.planConcurrencyLimit)])
  );
}

function allocationTotal(environments: ConcurrencyResult["environments"]) {
  const allocation = initialAllocation(environments);
  return Array.from(allocation.values()).reduce((e, acc) => e + acc, 0);
}

function Upgradable({
  extraConcurrency,
  extraAllocatedConcurrency,
  extraUnallocatedConcurrency,
  environments,
  concurrencyPricing,
  maxQuota,
}: ConcurrencyResult) {
  const lastSubmission = useActionData();
  const [form, { environments: formEnvironments }] = useForm({
    id: "purchase-concurrency",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: FormSchema });
    },
    shouldRevalidate: "onSubmit",
  });

  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle" && navigation.formMethod === "POST";

  const [allocation, setAllocation] = useState(initialAllocation(environments));

  const allocatedInProject = Array.from(allocation.values()).reduce((e, acc) => e + acc, 0);
  const initialAllocationInProject = allocationTotal(environments);
  const changeInAllocation = allocatedInProject - initialAllocationInProject;
  const unallocated = extraUnallocatedConcurrency - changeInAllocation;
  const allocationModified = changeInAllocation !== 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="border-b border-grid-dimmed pb-1">
        <Header2>Manage your concurrency</Header2>
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
              extraUnallocatedConcurrency={extraUnallocatedConcurrency}
              maxQuota={maxQuota}
              disabled={unallocated < 0 ? false : allocationModified}
            />
          </div>
          <Table variant="bright/no-hover">
            <TableBody>
              <TableRow>
                <TableCell className="pl-0 text-text-bright">Extra concurrency purchased</TableCell>
                <TableCell alignment="right" className="tabular-nums text-text-bright">
                  {extraConcurrency}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Allocated concurrency</TableCell>
                <TableCell alignment="right" className={"tabular-nums text-text-bright"}>
                  {allocationModified ? (
                    <>
                      <span className="text-text-dimmed line-through">
                        {extraAllocatedConcurrency}
                      </span>{" "}
                      {extraAllocatedConcurrency + changeInAllocation}
                    </>
                  ) : (
                    extraAllocatedConcurrency
                  )}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Unallocated concurrency</TableCell>
                <TableCell
                  alignment="right"
                  className={cn(
                    "tabular-nums",
                    unallocated > 0
                      ? "text-success"
                      : unallocated < 0
                      ? "text-error"
                      : "text-text-bright"
                  )}
                >
                  {allocationModified ? (
                    <>
                      <span className="text-text-dimmed line-through">
                        {extraUnallocatedConcurrency}
                      </span>{" "}
                      {extraUnallocatedConcurrency - changeInAllocation}
                    </>
                  ) : (
                    extraUnallocatedConcurrency
                  )}
                </TableCell>
              </TableRow>
              <TableRow className={allocationModified ? undefined : "after:bg-transparent"}>
                <TableCell colSpan={2} className="py-0">
                  <div className="flex h-10 items-center">
                    {allocationModified ? (
                      unallocated < 0 ? (
                        <div className="flex items-center gap-1">
                          <ExclamationTriangleIcon className="size-4 text-error" />
                          <span className="text-error">
                            You're trying to allocate more concurrency than your total purchased
                            amount.
                          </span>
                        </div>
                      ) : (
                        <div className="flex w-full items-center justify-between gap-3">
                          <div className="flex items-center gap-1">
                            <InformationCircleIcon className="size-4 text-text-dimmed" />
                            <span>
                              Save your changes or{" "}
                              <button
                                className="inline text-indigo-500 hover:text-indigo-300"
                                onClick={() => {
                                  setAllocation(initialAllocation(environments));
                                }}
                              >
                                reset
                              </button>
                              .
                            </span>
                          </div>
                          <Button
                            variant="primary/small"
                            type="submit"
                            form="allocate"
                            disabled={unallocated < 0 || isLoading}
                            LeadingIcon={isLoading ? SpinnerWhite : undefined}
                          >
                            Save
                          </Button>
                        </div>
                      )
                    ) : (
                      <></>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <FormError id={formEnvironments.id}>{formEnvironments.error}</FormError>
        </div>
        <Form className="flex flex-col gap-2" method="post" {...form.props} id="allocate">
          <input type="hidden" name="action" value="allocate" />
          <div className="flex items-center pb-1">
            <Header3 className="grow">Concurrency allocation</Header3>
          </div>
          <Table variant="bright/no-hover">
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
              {environments.map((environment, index) => (
                <TableRow key={environment.id}>
                  <TableCell>
                    <EnvironmentCombo environment={environment} />
                  </TableCell>
                  <TableCell alignment="right">{environment.planConcurrencyLimit}</TableCell>
                  <TableCell alignment="right">
                    <div className="flex items-center justify-end">
                      {environment.type === "DEVELOPMENT" ? (
                        Math.max(
                          0,
                          environment.maximumConcurrencyLimit - environment.planConcurrencyLimit
                        )
                      ) : (
                        <>
                          <input
                            type="hidden"
                            name={`environments[${index}].id`}
                            value={environment.id}
                          />
                          <Input
                            name={`environments[${index}].amount`}
                            type="number"
                            variant="outline/small"
                            className="text-right"
                            containerClassName="w-16"
                            fullWidth={false}
                            value={allocation.get(environment.id)}
                            onChange={(e) => {
                              const value = e.target.value === "" ? 0 : Number(e.target.value);
                              setAllocation(new Map(allocation).set(environment.id, value));
                            }}
                            min={0}
                          />
                        </>
                      )}
                    </div>
                  </TableCell>
                  <TableCell alignment="right">
                    {environment.planConcurrencyLimit + (allocation.get(environment.id) ?? 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Form>
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
        <Table variant="bright/no-hover">
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
  extraUnallocatedConcurrency,
  maxQuota,
  disabled,
}: {
  concurrencyPricing: {
    stepSize: number;
    centsPerStep: number;
  };
  extraConcurrency: number;
  extraUnallocatedConcurrency: number;
  maxQuota: number;
  disabled: boolean;
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

  const [amountValue, setAmountValue] = useState(extraConcurrency);
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle" && navigation.formMethod === "POST";

  // Close the panel, when we've succeeded
  // This is required because a redirect to the same path doesn't clear state
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const success = searchParams.get("success");
    if (success) {
      setOpen(false);
      setSearchParams((s) => {
        s.delete("success");
        return s;
      });
    }
  }, [searchParams.get("success")]);

  const state = updateState({
    value: amountValue,
    existingValue: extraConcurrency,
    quota: maxQuota,
    extraUnallocatedConcurrency,
  });
  const changeClassName =
    state === "decrease" ? "text-error" : state === "increase" ? "text-success" : undefined;

  const title = extraConcurrency === 0 ? "Purchase extra concurrency" : "Add/remove concurrency";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="primary/small"
          disabled={disabled}
          onClick={() => {
            setOpen(true);
          }}
        >
          {title}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>{title}</DialogHeader>
        <Form method="post" {...form.props}>
          <div className="flex flex-col gap-4 pt-2">
            <Paragraph variant="base/bright" spacing>
              You can purchase bundles of {concurrencyPricing.stepSize} concurrency for{" "}
              {formatCurrency(concurrencyPricing.centsPerStep / 100, false)}/month. Or you can
              remove any extra concurrency after you have unallocated it from your environments
              first.
            </Paragraph>
            <Fieldset>
              <InputGroup fullWidth>
                <Label htmlFor="amount" className="text-text-dimmed">
                  Total extra concurrency
                </Label>
                <InputNumberStepper
                  {...conform.input(amount, { type: "number" })}
                  step={concurrencyPricing.stepSize}
                  min={0}
                  max={undefined}
                  value={amountValue}
                  onChange={(e) => setAmountValue(Number(e.target.value))}
                  disabled={isLoading}
                />
                <FormError id={amount.errorId}>{amount.error}</FormError>
                <FormError>{form.error}</FormError>
              </InputGroup>
            </Fieldset>
            {state === "need_to_increase_unallocated" ? (
              <div className="flex flex-col pb-3">
                <Paragraph variant="small" className="text-warning" spacing>
                  You need to unallocate{" "}
                  {formatNumber(extraConcurrency - amountValue - extraUnallocatedConcurrency)} more
                  concurrency from your environments in order to remove{" "}
                  {formatNumber(extraConcurrency - amountValue)} concurrency from your account.
                </Paragraph>
              </div>
            ) : state === "above_quota" ? (
              <div className="flex flex-col pb-3">
                <Paragraph variant="small" className="text-warning" spacing>
                  Currently you can only have up to {maxQuota} extra concurrency. Send a request
                  below to lift your current limit. We'll get back to you soon.
                </Paragraph>
              </div>
            ) : (
              <div className="flex flex-col pb-3 tabular-nums">
                <div className="grid grid-cols-2 border-b border-grid-dimmed pb-1">
                  <Header3 className="font-normal text-text-dimmed">Summary</Header3>
                  <Header3 className="justify-self-end font-normal text-text-dimmed">Total</Header3>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className="pb-0 font-normal text-text-dimmed">
                    <span className="text-text-bright">{formatNumber(extraConcurrency)}</span>{" "}
                    current total
                  </Header3>
                  <Header3 className="justify-self-end font-normal text-text-bright">
                    {formatCurrency(
                      (extraConcurrency * concurrencyPricing.centsPerStep) /
                        concurrencyPricing.stepSize /
                        100,
                      true
                    )}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({extraConcurrency / concurrencyPricing.stepSize} bundles)
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className={cn("pb-0 font-normal", changeClassName)}>
                    {state === "increase" ? "+" : null}
                    {formatNumber(amountValue - extraConcurrency)}
                  </Header3>
                  <Header3 className={cn("justify-self-end font-normal", changeClassName)}>
                    {state === "increase" ? "+" : null}
                    {formatCurrency(
                      ((amountValue - extraConcurrency) * concurrencyPricing.centsPerStep) /
                        concurrencyPricing.stepSize /
                        100,
                      true
                    )}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({(amountValue - extraConcurrency) / concurrencyPricing.stepSize} bundles @{" "}
                    {formatCurrency(concurrencyPricing.centsPerStep / 100, true)}/mth)
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className="pb-0 font-normal text-text-dimmed">
                    <span className="text-text-bright">{formatNumber(amountValue)}</span> new total
                  </Header3>
                  <Header3 className="justify-self-end font-normal text-text-bright">
                    {formatCurrency(
                      (amountValue * concurrencyPricing.centsPerStep) /
                        concurrencyPricing.stepSize /
                        100,
                      true
                    )}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({amountValue / concurrencyPricing.stepSize} bundles)
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
              </div>
            )}
          </div>
          <FormButtons
            confirmButton={
              state === "above_quota" ? (
                <>
                  <input type="hidden" name="action" value="quota-increase" />
                  <Button
                    LeadingIcon={isLoading ? SpinnerWhite : EnvelopeIcon}
                    variant="primary/medium"
                    type="submit"
                    disabled={isLoading}
                  >
                    {`Send request for ${formatNumber(amountValue)}`}
                  </Button>
                </>
              ) : state === "decrease" || state === "need_to_increase_unallocated" ? (
                <>
                  <input type="hidden" name="action" value="purchase" />
                  <Button
                    variant="danger/medium"
                    type="submit"
                    disabled={isLoading || state === "need_to_increase_unallocated"}
                    LeadingIcon={isLoading ? SpinnerWhite : undefined}
                  >
                    {`Remove ${formatNumber(extraConcurrency - amountValue)} concurrency`}
                  </Button>
                </>
              ) : (
                <>
                  <input type="hidden" name="action" value="purchase" />
                  <Button
                    variant="primary/medium"
                    type="submit"
                    disabled={isLoading || state === "no_change"}
                    LeadingIcon={isLoading ? SpinnerWhite : undefined}
                  >
                    {`Purchase ${formatNumber(amountValue - extraConcurrency)} concurrency`}
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

function updateState({
  value,
  existingValue,
  quota,
  extraUnallocatedConcurrency,
}: {
  value: number;
  existingValue: number;
  quota: number;
  extraUnallocatedConcurrency: number;
}): "no_change" | "increase" | "decrease" | "above_quota" | "need_to_increase_unallocated" {
  if (value === existingValue) return "no_change";
  if (value < existingValue) {
    const difference = existingValue - value;
    if (difference > extraUnallocatedConcurrency) {
      return "need_to_increase_unallocated";
    }
    return "decrease";
  }
  if (value > quota) return "above_quota";
  return "increase";
}

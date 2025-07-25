import { conform, list, requestIntent, useFieldList, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { BellAlertIcon, CurrencyDollarIcon, EnvelopeIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, type MetaFunction } from "@remix-run/react";
import { type ActionFunction, json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Fragment, useRef, useState } from "react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { getBillingAlerts, setBillingAlert } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import {
  OrganizationParamsSchema,
  organizationPath,
  v3BillingAlertsPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Billing alerts | Trigger.dev`,
    },
  ];
};

export async function loader({ params, request }: LoaderFunctionArgs) {
  await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const { isManagedCloud } = featuresForRequest(request);
  if (!isManagedCloud) {
    return redirect(organizationPath({ slug: organizationSlug }));
  }

  const organization = await prisma.organization.findUnique({
    where: { slug: organizationSlug },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  const alerts = await getBillingAlerts(organization.id);
  if (!alerts) {
    throw new Response(null, { status: 404, statusText: "Plans not found" });
  }

  return typedjson({
    alerts: {
      ...alerts,
      amount: alerts.amount / 100,
    },
  });
}

const schema = z.object({
  amount: z
    .number({ invalid_type_error: "Not a valid amount" })
    .min(0, "Amount must be greater than 0"),
  emails: z.preprocess((i) => {
    if (typeof i === "string") return [i];

    if (Array.isArray(i)) {
      const emails = i.filter((v) => typeof v === "string" && v !== "");
      if (emails.length === 0) {
        return [""];
      }
      return emails;
    }

    return [""];
  }, z.string().email().array().nonempty("At least one email is required")),
  alertLevels: z.preprocess((i) => {
    if (typeof i === "string") return [i];
    return i;
  }, z.coerce.number().array().nonempty("At least one alert level is required")),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    const organization = await prisma.organization.findFirst({
      where: { slug: organizationSlug, members: { some: { userId } } },
    });

    if (!organization) {
      return redirectWithErrorMessage(
        v3BillingAlertsPath({ slug: organizationSlug }),
        request,
        "You are not authorized to update billing alerts"
      );
    }

    const updatedAlert = await setBillingAlert(organization.id, {
      ...submission.value,
      amount: submission.value.amount * 100,
    });
    if (!updatedAlert) {
      return redirectWithErrorMessage(
        v3BillingAlertsPath({ slug: organizationSlug }),
        request,
        "Failed to update billing alert"
      );
    }

    return redirectWithSuccessMessage(
      v3BillingAlertsPath({ slug: organizationSlug }),
      request,
      "Billing alert updated"
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const { alerts } = useTypedLoaderData<typeof loader>();
  const [dollarAmount, setDollarAmount] = useState(alerts.amount.toFixed(2));
  const organization = useOrganization();

  const lastSubmission = useActionData();

  const [form, { emails, amount, alertLevels }] = useForm({
    id: "invite-members",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    defaultValue: {
      emails: [""],
    },
  });

  const fieldValues = useRef<string[]>([""]);
  const emailFields = useFieldList(form.ref, { ...emails, defaultValue: alerts.emails });

  const checkboxLevels = [0.75, 0.9, 1.0];

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Billing alerts" />
        <PageAccessories>
          <AdminDebugTooltip />
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={true}>
        <MainHorizontallyCenteredContainer>
          <div>
            <Header2 spacing>Billing alerts</Header2>
            <Paragraph spacing variant="small">
              Receive emails when your compute spend crosses the thresholds set below.
            </Paragraph>
            <Form method="post" {...form.props}>
              <Fieldset>
                <InputGroup>
                  <Label htmlFor={amount.id}>Amount</Label>
                  <Input
                    {...conform.input(amount, { type: "number" })}
                    value={dollarAmount}
                    onChange={(e) => {
                      const numberValue = Number(e.target.value);
                      if (numberValue < 0) {
                        setDollarAmount("");
                        return;
                      }
                      setDollarAmount(e.target.value);
                    }}
                    step={0.01}
                    min={0}
                    placeholder="Enter an amount"
                    icon={<span className="-mt-0.5 block pl-0.5 text-sm text-text-dimmed">$</span>}
                    className="pl-px"
                  />
                  <FormError id={amount.errorId}>{amount.error}</FormError>
                </InputGroup>
                <InputGroup>
                  <Label htmlFor={alertLevels.id}>Alert me when I reach</Label>
                  {checkboxLevels.map((level) => (
                    <CheckboxWithLabel
                      name={alertLevels.name}
                      id={`level_${level}`}
                      value={level.toString()}
                      variant="simple/small"
                      label={`${level * 100}% ($${(Number(dollarAmount) * level).toFixed(2)})`}
                      defaultChecked
                      className="pr-0"
                    />
                  ))}
                  <FormError id={alertLevels.errorId}>{alertLevels.error}</FormError>
                </InputGroup>
                <InputGroup>
                  <Label htmlFor={emails.id}>Email addresses</Label>
                  {emailFields.map((email, index) => (
                    <Fragment key={email.key}>
                      <Input
                        {...conform.input(email, { type: "email" })}
                        placeholder={index === 0 ? "Enter an email address" : "Add another email"}
                        icon={EnvelopeIcon}
                        autoFocus={index === 0}
                        onChange={(e) => {
                          fieldValues.current[index] = e.target.value;
                          if (
                            emailFields.length === fieldValues.current.length &&
                            fieldValues.current.every((v) => v !== "")
                          ) {
                            requestIntent(form.ref.current ?? undefined, list.append(emails.name));
                          }
                        }}
                      />
                      <FormError id={email.errorId}>{email.error}</FormError>
                    </Fragment>
                  ))}
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <Button type="submit" variant={"primary/small"}>
                      Update
                    </Button>
                  }
                />
              </Fieldset>
            </Form>
          </div>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}

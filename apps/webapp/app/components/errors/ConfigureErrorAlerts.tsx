import { conform, list, requestIntent, useFieldList, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  EnvelopeIcon,
  GlobeAltIcon,
  HashtagIcon,
  LockClosedIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { SlackIcon } from "@trigger.dev/companyicons";
import { Fragment, useRef, useState } from "react";
import { z } from "zod";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout, variantClasses } from "~/components/primitives/Callout";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { InlineCode } from "~/components/code/InlineCode";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { UnorderedList } from "~/components/primitives/UnorderedList";
import type { ErrorAlertChannelData } from "~/presenters/v3/ErrorAlertChannelPresenter.server";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { cn } from "~/utils/cn";
import { ExitIcon } from "~/assets/icons/ExitIcon";

export const ErrorAlertsFormSchema = z.object({
  emails: z.preprocess((i) => {
    if (typeof i === "string") return i === "" ? [] : [i];
    if (Array.isArray(i)) return i.filter((v) => typeof v === "string" && v !== "");
    return [];
  }, z.string().email().array()),
  slackChannel: z.string().optional(),
  slackIntegrationId: z.string().optional(),
  webhooks: z.preprocess((i) => {
    if (typeof i === "string") return i === "" ? [] : [i];
    if (Array.isArray(i)) return i.filter((v) => typeof v === "string" && v !== "");
    return [];
  }, z.string().url().array()),
});

type ConfigureErrorAlertsProps = ErrorAlertChannelData & {
  connectToSlackHref?: string;
};

export function ConfigureErrorAlerts({
  emails: existingEmails,
  webhooks: existingWebhooks,
  slackChannel: existingSlackChannel,
  slack,
  emailAlertsEnabled,
  connectToSlackHref,
}: ConfigureErrorAlertsProps) {
  const fetcher = useFetcher();
  const location = useOptimisticLocation();
  const isSubmitting = fetcher.state !== "idle";

  const [selectedSlackChannelValue, setSelectedSlackChannelValue] = useState<string | undefined>(
    existingSlackChannel
      ? `${existingSlackChannel.channelId}/${existingSlackChannel.channelName}`
      : undefined
  );

  const selectedSlackChannel =
    slack.status === "READY"
      ? slack.channels?.find((s) => selectedSlackChannelValue === `${s.id}/${s.name}`)
      : undefined;

  const closeHref = (() => {
    const params = new URLSearchParams(location.search);
    params.delete("alerts");
    const qs = params.toString();
    return qs ? `?${qs}` : location.pathname;
  })();

  const emailFieldValues = useRef<string[]>(
    existingEmails.length > 0 ? [...existingEmails.map((e) => e.email), ""] : [""]
  );

  const webhookFieldValues = useRef<string[]>(
    existingWebhooks.length > 0 ? [...existingWebhooks.map((w) => w.url), ""] : [""]
  );

  const [form, { emails, webhooks, slackChannel, slackIntegrationId }] = useForm({
    id: "configure-error-alerts",
    onValidate({ formData }) {
      return parse(formData, { schema: ErrorAlertsFormSchema });
    },
    shouldRevalidate: "onSubmit",
    defaultValue: {
      emails: emailFieldValues.current,
      webhooks: webhookFieldValues.current,
    },
  });

  const emailFields = useFieldList(form.ref, emails);
  const webhookFields = useFieldList(form.ref, webhooks);

  return (
    <div className="grid h-full grid-rows-[auto_1fr_auto] overflow-hidden">
      <div className="flex items-center justify-between border-b border-grid-bright px-3 py-2">
        <Header2>Configure alerts</Header2>
        <LinkButton
          to={closeHref}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <fetcher.Form method="post" {...form.props}>
          <Fieldset className="flex flex-col gap-3 p-4">
            <div className="flex flex-col">
              <Paragraph variant="small/dimmed">You'll receive alerts when</Paragraph>
              <UnorderedList variant="small/dimmed" className="mt-1">
                <li>An error is seen for the first time</li>
                <li>A resolved error re-occurs</li>
                <li>An ignored error re-occurs based on settings you configured</li>
              </UnorderedList>
            </div>

            {/* Email section */}
            <div>
              <Header3 className="mb-3 flex items-center gap-1.5">
                <EnvelopeIcon className="size-4 text-text-dimmed" />
                Email
              </Header3>
              {emailAlertsEnabled ? (
                <InputGroup>
                  {emailFields.map((emailField, index) => (
                    <Fragment key={emailField.key}>
                      <Input
                        {...conform.input(emailField, { type: "email" })}
                        placeholder={index === 0 ? "Enter an email address" : "Add another email"}
                        icon={EnvelopeIcon}
                        onChange={(e) => {
                          emailFieldValues.current[index] = e.target.value;
                          if (
                            emailFields.length === emailFieldValues.current.length &&
                            emailFieldValues.current.every((v) => v !== "")
                          ) {
                            requestIntent(form.ref.current ?? undefined, list.append(emails.name));
                          }
                        }}
                      />
                      <FormError id={emailField.errorId}>{emailField.error}</FormError>
                    </Fragment>
                  ))}
                </InputGroup>
              ) : (
                <Callout variant="warning">
                  Email integration is not available. Please contact your organization
                  administrator.
                </Callout>
              )}
            </div>

            {/* Slack section */}
            <div>
              <Header3 className="mb-3 flex items-center gap-1.5">
                <SlackIcon className="size-4" />
                Slack
              </Header3>
              <InputGroup fullWidth>
                {slack.status === "READY" ? (
                  <>
                    <Select
                      name={slackChannel.name}
                      placeholder="Select a Slack channel"
                      heading="Filter channels…"
                      defaultValue={selectedSlackChannelValue}
                      dropdownIcon
                      variant="tertiary/medium"
                      items={slack.channels}
                      setValue={(value) => {
                        typeof value === "string" && setSelectedSlackChannelValue(value);
                      }}
                      filter={(channel, search) =>
                        channel.name?.toLowerCase().includes(search.toLowerCase()) ?? false
                      }
                      text={(value) => {
                        const channel = slack.channels.find((s) => value === `${s.id}/${s.name}`);
                        if (!channel) return;
                        return <SlackChannelTitle {...channel} />;
                      }}
                    >
                      {(matches) => (
                        <>
                          {matches?.map((channel) => (
                            <SelectItem key={channel.id} value={`${channel.id}/${channel.name}`}>
                              <SlackChannelTitle {...channel} />
                            </SelectItem>
                          ))}
                        </>
                      )}
                    </Select>
                    {selectedSlackChannel && selectedSlackChannel.is_private && (
                      <Callout
                        variant="warning"
                        className={cn("text-sm", variantClasses.warning.textColor)}
                      >
                        To receive alerts in the{" "}
                        <InlineCode variant="extra-small">{selectedSlackChannel.name}</InlineCode>{" "}
                        channel, you need to invite the @Trigger.dev Slack Bot. Go to the channel in
                        Slack and type:{" "}
                        <InlineCode variant="extra-small">/invite @Trigger.dev</InlineCode>.
                      </Callout>
                    )}
                    <input
                      type="hidden"
                      name={slackIntegrationId.name}
                      value={slack.integrationId}
                    />
                  </>
                ) : slack.status === "NOT_CONFIGURED" ? (
                  connectToSlackHref ? (
                    <LinkButton variant="tertiary/large" to={connectToSlackHref} fullWidth>
                      <span className="flex items-center gap-2 text-text-bright">
                        <SlackIcon className="size-5" /> Connect to Slack
                      </span>
                    </LinkButton>
                  ) : (
                    <Callout variant="info">
                      Slack is not connected. Connect Slack from the{" "}
                      <span className="font-medium text-text-bright">Alerts</span> page to enable
                      Slack notifications.
                    </Callout>
                  )
                ) : slack.status === "TOKEN_REVOKED" || slack.status === "TOKEN_EXPIRED" ? (
                  connectToSlackHref ? (
                    <div className="flex flex-col gap-4">
                      <Callout variant="info">
                        The Slack integration in your workspace has been revoked or has expired.
                        Please re-connect your Slack workspace.
                      </Callout>
                      <LinkButton
                        variant="tertiary/large"
                        to={`${connectToSlackHref}?reinstall=true`}
                        fullWidth
                      >
                        <span className="flex items-center gap-2 text-text-bright">
                          <SlackIcon className="size-5" /> Connect to Slack
                        </span>
                      </LinkButton>
                    </div>
                  ) : (
                    <Callout variant="info">
                      The Slack integration in your workspace has been revoked or expired. Please
                      re-connect from the{" "}
                      <span className="font-medium text-text-bright">Alerts</span> page.
                    </Callout>
                  )
                ) : slack.status === "FAILED_FETCHING_CHANNELS" ? (
                  <Callout variant="warning">
                    Failed loading channels from Slack. Please try again later.
                  </Callout>
                ) : (
                  <Callout variant="warning">
                    Slack integration is not available. Please contact your organization
                    administrator.
                  </Callout>
                )}
              </InputGroup>
            </div>

            {/* Webhook section */}
            <div>
              <Header3 className="mb-3 flex items-center gap-1.5">
                <GlobeAltIcon className="size-4 text-text-dimmed" />
                Webhook
              </Header3>
              <InputGroup>
                {webhookFields.map((webhookField, index) => (
                  <Fragment key={webhookField.key}>
                    <Input
                      {...conform.input(webhookField, { type: "url" })}
                      placeholder={
                        index === 0 ? "https://example.com/webhook" : "Add another webhook URL"
                      }
                      icon={GlobeAltIcon}
                      onChange={(e) => {
                        webhookFieldValues.current[index] = e.target.value;
                        if (
                          webhookFields.length === webhookFieldValues.current.length &&
                          webhookFieldValues.current.every((v) => v !== "")
                        ) {
                          requestIntent(form.ref.current ?? undefined, list.append(webhooks.name));
                        }
                      }}
                    />
                    <FormError id={webhookField.errorId}>{webhookField.error}</FormError>
                  </Fragment>
                ))}
                <Hint>We'll issue POST requests to these URLs with a JSON payload.</Hint>
              </InputGroup>
            </div>

            <FormError>{form.error}</FormError>
          </Fieldset>
        </fetcher.Form>
      </div>

      <div className="border-t border-grid-bright px-4 py-3">
        <Button
          variant="primary/medium"
          type="submit"
          form="configure-error-alerts"
          disabled={isSubmitting}
          fullWidth
        >
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function SlackChannelTitle({ name, is_private }: { name?: string; is_private?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      {is_private ? <LockClosedIcon className="size-4" /> : <HashtagIcon className="size-4" />}
      <span>{name}</span>
    </div>
  );
}

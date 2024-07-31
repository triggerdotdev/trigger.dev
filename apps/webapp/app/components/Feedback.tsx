import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { BookOpenIcon } from "@heroicons/react/20/solid";
import {
  CalendarDaysIcon,
  ChevronRightIcon,
  EnvelopeIcon,
  LifebuoyIcon,
  LightBulbIcon,
} from "@heroicons/react/24/solid";
import { Form, useActionData, useLocation, useNavigation } from "@remix-run/react";
import { DiscordIcon } from "@trigger.dev/companyicons";
import { ActivityIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type FeedbackType, feedbackTypeLabel, schema } from "~/routes/resources.feedback";
import { cn } from "~/utils/cn";
import { docsTroubleshootingPath } from "~/utils/pathBuilder";
import { Button, LinkButton } from "./primitives/Buttons";
import { Fieldset } from "./primitives/Fieldset";
import { FormButtons } from "./primitives/FormButtons";
import { FormError } from "./primitives/FormError";
import { Header1 } from "./primitives/Headers";
import { InputGroup } from "./primitives/InputGroup";
import { Label } from "./primitives/Label";
import { Paragraph } from "./primitives/Paragraph";
import { Select, SelectItem } from "./primitives/Select";
import { Sheet, SheetBody, SheetContent, SheetTrigger } from "./primitives/Sheet";
import { TextArea } from "./primitives/TextArea";

type FeedbackProps = {
  button: ReactNode;
  defaultValue?: FeedbackType;
};

export function Feedback({ button, defaultValue = "bug" }: FeedbackProps) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const [form, { path, feedbackType, message }] = useForm({
    id: "accept-invite",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  if (
    open &&
    navigation.formAction === "/resources/feedback" &&
    form.error === undefined &&
    form.errors.length === 0
  ) {
    setOpen(false);
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild={true}>{button}</SheetTrigger>
      <SheetContent className="@container">
        <SheetBody className="flex h-full flex-col justify-between">
          <LinkBanner
            title="Join our Discord community"
            icon={<DiscordIcon className="size-9" />}
            to="https://trigger.dev/discord"
            className="hover:border-text-link"
          >
            <Paragraph>The quickest way to get answers from the Trigger.dev community.</Paragraph>
          </LinkBanner>
          <LinkBanner
            title="Book a 15 min chat with the founders"
            icon={<CalendarDaysIcon className="size-9 text-green-500" />}
            to="https://cal.com/team/triggerdotdev/founders-call"
            className="hover:border-green-500"
          >
            <Paragraph>Have a question or want to chat? Book a time to talk with us.</Paragraph>
          </LinkBanner>
          <LinkBanner
            title="Suggest a feature"
            icon={<LightBulbIcon className="size-9 text-sun-500" />}
            to="https://feedback.trigger.dev/"
            className="hover:border-sun-400"
          >
            <Paragraph>Have an idea for a new feature or improvement? Let us know!</Paragraph>
          </LinkBanner>
          <LinkBanner
            title="Troubleshooting"
            icon={<LifebuoyIcon className="size-9 text-rose-500" />}
          >
            <Paragraph>
              If you're having trouble, check out our troubleshooting guide or the Trigger.dev
              Status page.
            </Paragraph>
            <div className="flex flex-wrap gap-2">
              <LinkButton
                to={docsTroubleshootingPath("")}
                variant="tertiary/medium"
                LeadingIcon={BookOpenIcon}
              >
                Troubleshooting Docs
              </LinkButton>
              <LinkButton
                to={"https://status.trigger.dev/"}
                variant="tertiary/medium"
                LeadingIcon={ActivityIcon}
              >
                Trigger.dev Status
              </LinkButton>
            </div>
          </LinkBanner>
          <LinkBanner
            title="Send us an email"
            icon={<EnvelopeIcon className="size-9 text-blue-500" />}
          >
            <Paragraph>We read every message and respond quickly.</Paragraph>
            <Form method="post" action="/resources/feedback" {...form.props} className="w-full">
              <Fieldset className="max-w-full gap-y-3">
                <input value={location.pathname} {...conform.input(path, { type: "hidden" })} />
                <InputGroup className="max-w-full">
                  <Select
                    {...conform.select(feedbackType)}
                    variant="tertiary/medium"
                    defaultValue={defaultValue}
                    placeholder="Select type"
                    text={(value) => feedbackTypeLabel[value]}
                    dropdownIcon
                  >
                    {Object.entries(feedbackTypeLabel).map(([name, title]) => (
                      <SelectItem key={name} value={name}>
                        {title}
                      </SelectItem>
                    ))}
                  </Select>
                  <FormError id={feedbackType.errorId}>{feedbackType.error}</FormError>
                </InputGroup>
                <InputGroup className="max-w-full">
                  <Label>Message</Label>
                  <TextArea {...conform.textarea(message)} />
                  <FormError id={message.errorId}>{message.error}</FormError>
                </InputGroup>
                <FormError>{form.error}</FormError>
                <div className="flex w-full justify-end">
                  <FormButtons
                    className="m-0 w-max"
                    confirmButton={
                      <Button type="submit" variant="tertiary/medium">
                        Send message
                      </Button>
                    }
                  />
                </div>
              </Fieldset>
            </Form>
          </LinkBanner>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function LinkBanner({
  className,
  icon,
  title,
  children,
  to,
}: {
  className?: string;
  icon?: ReactNode;
  title?: string;
  children?: ReactNode;
  to?: string;
}) {
  return (
    <a
      href={to}
      target="_blank"
      className={cn(
        "group/banner mb-4 flex w-full items-center justify-between rounded-md border border-grid-bright bg-charcoal-750 p-4 transition",
        className
      )}
    >
      <div className="flex w-full items-start gap-4">
        <span>{icon}</span>
        <div className="flex w-full flex-col gap-2">
          <Header1 className="text-2xl font-semibold text-text-bright">{title}</Header1>
          {children}
        </div>
      </div>
      {to && (
        <ChevronRightIcon className="size-5 text-charcoal-500 transition group-hover:translate-x-1 group-hover/banner:text-text-bright" />
      )}
    </a>
  );
}

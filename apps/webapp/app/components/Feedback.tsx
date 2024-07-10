import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { BookOpenIcon } from "@heroicons/react/20/solid";
import { ChevronRightIcon } from "@heroicons/react/24/solid";
import { Form, useActionData, useLocation, useNavigation } from "@remix-run/react";
import { DiscordIcon, GitHubLightIcon } from "@trigger.dev/companyicons";
import { ActivityIcon } from "lucide-react";
import { ReactNode, useState } from "react";
import { FeedbackType, feedbackTypeLabel, schema } from "~/routes/resources.feedback";
import { cn } from "~/utils/cn";
import { docsPath } from "~/utils/pathBuilder";
import { Button, LinkButton } from "./primitives/Buttons";
import { Fieldset } from "./primitives/Fieldset";
import { FormButtons } from "./primitives/FormButtons";
import { FormError } from "./primitives/FormError";
import { Header1, Header2 } from "./primitives/Headers";
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
          <Header2 className="mb-2.5 text-xl">Send us an email</Header2>
          <Paragraph className="mb-4">We read every message and respond quickly.</Paragraph>
          <Form method="post" action="/resources/feedback" {...form.props}>
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
          <hr className="my-4" />
          <DiscordBanner />
          <hr className="mb-4" />
          <Header2 className="mb-2.5 text-xl">Troubleshooting</Header2>
          <Paragraph className="mb-4">
            If you're having trouble, check out our documentation or the Trigger.dev Status page.
          </Paragraph>
          <div className="flex flex-wrap gap-2">
            <LinkButton to={docsPath("")} variant="tertiary/medium" LeadingIcon={BookOpenIcon}>
              Docs
            </LinkButton>
            <LinkButton
              to={"https://status.trigger.dev/"}
              variant="tertiary/medium"
              LeadingIcon={ActivityIcon}
            >
              Trigger.dev Status
            </LinkButton>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function DiscordBanner({ className }: { className?: string }) {
  return (
    <a
      href="https://trigger.dev/discord"
      target="_blank"
      className={cn(
        "group mb-4 flex w-full items-center justify-between rounded-md border border-grid-bright bg-charcoal-750 p-4 pl-6 transition hover:border-text-link",
        className
      )}
    >
      <div className="flex items-center gap-6">
        <DiscordIcon className="size-12" />
        <div className="flex flex-col gap-2">
          <Header1 className="text-2xl font-semibold text-text-bright transition group-hover:text-white">
            Join our Discord community
          </Header1>
          <Paragraph>The quickest way to get answers from the Trigger.dev community.</Paragraph>
        </div>
      </div>
      <ChevronRightIcon className="size-5 text-charcoal-500 transition group-hover:translate-x-1 group-hover:text-text-link" />
    </a>
  );
}

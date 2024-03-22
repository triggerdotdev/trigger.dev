import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ChevronRightIcon } from "@heroicons/react/24/solid";
import { Form, useActionData, useLocation, useNavigation } from "@remix-run/react";
import { DiscordIcon, GitHubLightIcon } from "@trigger.dev/companyicons";
import { ReactNode, useState } from "react";
import { FeedbackType, feedbackTypeLabel, schema } from "~/routes/resources.feedback";
import { Button, LinkButton } from "./primitives/Buttons";
import { Fieldset } from "./primitives/Fieldset";
import { FormButtons } from "./primitives/FormButtons";
import { FormError } from "./primitives/FormError";
import { Header1, Header2 } from "./primitives/Headers";
import { InputGroup } from "./primitives/InputGroup";
import { Label } from "./primitives/Label";
import { Paragraph } from "./primitives/Paragraph";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./primitives/Select";
import { Sheet, SheetBody, SheetContent, SheetTrigger } from "./primitives/Sheet";
import { TextArea } from "./primitives/TextArea";
import { cn } from "~/utils/cn";
import { BookOpenIcon } from "@heroicons/react/20/solid";
import { ActivityIcon, HeartPulseIcon } from "lucide-react";
import { docsPath } from "~/utils/pathBuilder";

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
          <Header2 className="mb-2.5 text-xl">Get help from the community</Header2>
          <Paragraph className="mb-4">
            The quickest way to get help and feedback or to provide advice to others is to join our
            Discord.
          </Paragraph>
          <div className="flex flex-col gap-x-4 @[30rem]:flex-row">
            <DiscordBanner />
            <GitHubDiscussionsBanner />
          </div>
          <hr className="mb-4" />
          <Header2 className="mb-2.5 text-xl">Send us an email</Header2>
          <Paragraph className="mb-4">We read every message and respond quickly.</Paragraph>
          <Form method="post" action="/resources/feedback" {...form.props}>
            <Fieldset className="max-w-full gap-y-3">
              <input value={location.pathname} {...conform.input(path, { type: "hidden" })} />
              <InputGroup className="max-w-full">
                <SelectGroup>
                  <Select {...conform.input(feedbackType)} defaultValue={defaultValue}>
                    <SelectTrigger size="medium" width="full">
                      <SelectValue placeholder="Type" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(feedbackTypeLabel).map(([key, value]) => (
                        <SelectItem key={key} value={key}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SelectGroup>
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
          <Header2 className="mb-2.5 text-xl">Troubleshooting</Header2>
          <Paragraph className="mb-4">
            If you're having trouble, check out our documentation or the Trigger.dev Status page.
          </Paragraph>
          <div className="flex flex-wrap gap-2">
            <LinkButton to={docsPath("")} variant="tertiary/medium" LeadingIcon={BookOpenIcon}>
              Docs
            </LinkButton>
            <LinkButton
              to={docsPath("v3/introduction")}
              variant="tertiary/medium"
              LeadingIcon={BookOpenIcon}
            >
              v3 Docs (Developer preview)
            </LinkButton>
            <LinkButton
              to={"https://trigger.openstatus.dev/"}
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
        "group mb-4 flex w-full items-center justify-between rounded-md border border-charcoal-600 p-4 transition hover:border-text-link",
        className
      )}
    >
      <div className="flex flex-col gap-y-2">
        <DiscordIcon className="h-8 w-8" />
        <Header1 className="text-2xl font-semibold text-text-bright transition group-hover:text-white">
          Join our Discord community
        </Header1>
        <Paragraph variant="small" className="mb-4">
          Get help or answer questions from the Trigger.dev community.
        </Paragraph>
      </div>
      <ChevronRightIcon className="size-5 text-charcoal-500 transition group-hover:translate-x-1 group-hover:text-text-link" />
    </a>
  );
}

function GitHubDiscussionsBanner({ className }: { className?: string }) {
  return (
    <a
      href="https://github.com/triggerdotdev/trigger.dev/discussions"
      target="_blank"
      className={cn(
        "group mb-4 flex w-full items-center justify-between rounded-md border border-charcoal-600 p-4 transition hover:border-text-dimmed",
        className
      )}
    >
      <div className="flex flex-col gap-y-2">
        <GitHubLightIcon className="mb-1 h-7 w-7" />
        <Header1 className="text-2xl font-semibold text-text-bright transition group-hover:text-white">
          View our GitHub Discussions
        </Header1>
        <Paragraph variant="small">
          Post your questions, feedback, and feature requests on GitHub.
        </Paragraph>
      </div>
      <ChevronRightIcon className="size-5 text-charcoal-500 transition group-hover:translate-x-1 group-hover:text-text-bright" />
    </a>
  );
}

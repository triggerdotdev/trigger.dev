import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData, useLocation, useNavigation } from "@remix-run/react";
import { ReactNode, useState } from "react";
import { FeedbackType, feedbackTypeLabel, schema } from "~/routes/resources.feedback";
import { Button } from "./primitives/Buttons";
import { Fieldset } from "./primitives/Fieldset";
import { FormButtons } from "./primitives/FormButtons";
import { FormError } from "./primitives/FormError";
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
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTrigger } from "./primitives/Sheet";
import { TextArea } from "./primitives/TextArea";
import { DiscordIcon } from "@trigger.dev/companyicons";
import { ChevronRightIcon } from "@heroicons/react/24/solid";

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
    lastSubmission,
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
      <SheetContent size="sm">
        <SheetHeader className="justify-between">Help & feedback</SheetHeader>
        <SheetBody>
          <DiscordBanner />
          <Paragraph variant="small" className="mb-4 border-t border-slate-800 pt-3">
            Or use this form to ask for help or give us feedback. We read every message and will get
            back to you as soon as we can.
          </Paragraph>
          <Form method="post" action="/resources/feedback" {...form.props}>
            <Fieldset className="max-w-full">
              <input value={location.pathname} {...conform.input(path, { type: "hidden" })} />
              <InputGroup className="max-w-full">
                <Label>How can we help?</Label>
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
              <FormButtons
                className="w-full"
                confirmButton={
                  <Button type="submit" variant="primary/medium">
                    Send
                  </Button>
                }
              />
            </Fieldset>
          </Form>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function DiscordBanner() {
  return (
    <a
      href="https://discord.gg/nkqV9xBYWy"
      target="_blank"
      className="group mb-4 flex w-full items-center justify-between rounded-md border border-slate-600 bg-gradient-to-br from-blue-400/30 to-indigo-400/50 p-4 transition hover:border-indigo-400"
    >
      <div className="flex flex-col gap-y-2">
        <DiscordIcon className="h-8 w-8" />
        <h2 className="font-title text-2xl text-bright transition group-hover:text-white">
          Join the Trigger.dev
          <br />
          Discord community
        </h2>
        <Paragraph variant="small">
          Get help or answer questions from the Trigger.dev community.
        </Paragraph>
      </div>
      <div className="h-full">
        <ChevronRightIcon className="h-5 w-5 text-slate-400 transition group-hover:translate-x-1 group-hover:text-indigo-400" />
      </div>
    </a>
  );
}

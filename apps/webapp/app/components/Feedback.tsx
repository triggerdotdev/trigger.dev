import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ChevronRightIcon } from "@heroicons/react/24/solid";
import { Form, useActionData, useLocation, useNavigation } from "@remix-run/react";
import { DiscordIcon } from "@trigger.dev/companyicons";
import { ReactNode, useState } from "react";
import { FeedbackType, feedbackTypeLabel, schema } from "~/routes/resources.feedback";
import { Button } from "./primitives/Buttons";
import { Fieldset } from "./primitives/Fieldset";
import { FormButtons } from "./primitives/FormButtons";
import { FormError } from "./primitives/FormError";
import { Header2 } from "./primitives/Headers";
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
      <SheetContent>
        <SheetHeader className="justify-between">How can we help?</SheetHeader>
        <SheetBody className="flex h-full flex-col justify-between">
          <DiscordBanner />
          <hr className="mb-3" />
          <Header2 className="mb-4">Send us a message</Header2>
          <Form method="post" action="/resources/feedback" {...form.props}>
            <Fieldset className="max-w-full">
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
              <div className="flex w-full items-center justify-between">
                <Paragraph variant="small" className="w-full">
                  We read every message and respond quickly.
                </Paragraph>
                <FormButtons
                  className="m-0 w-max"
                  confirmButton={
                    <Button type="submit" variant="primary/medium">
                      Send
                    </Button>
                  }
                />
              </div>
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
      href="https://trigger.dev/discord"
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
        <Paragraph variant="small/bright">
          Get help or answer questions from the Trigger.dev community.
        </Paragraph>
      </div>
      <ChevronRightIcon className="h-5 w-5 text-slate-400 transition group-hover:translate-x-1 group-hover:text-indigo-400" />
    </a>
  );
}

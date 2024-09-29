import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { EnvelopeIcon, LightBulbIcon } from "@heroicons/react/24/solid";
import { Form, useActionData, useLocation, useNavigation } from "@remix-run/react";
import { type ReactNode, useState } from "react";
import { type FeedbackType, feedbackTypeLabel, schema } from "~/routes/resources.feedback";
import { Button } from "./primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "./primitives/Dialog";
import { Fieldset } from "./primitives/Fieldset";
import { FormButtons } from "./primitives/FormButtons";
import { FormError } from "./primitives/FormError";
import { Icon } from "./primitives/Icon";
import { InfoPanel } from "./primitives/InfoPanel";
import { InputGroup } from "./primitives/InputGroup";
import { Label } from "./primitives/Label";
import { Paragraph } from "./primitives/Paragraph";
import { Select, SelectItem } from "./primitives/Select";
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
  const [type, setType] = useState<FeedbackType>(defaultValue);

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
    <Dialog>
      <DialogTrigger asChild>{button}</DialogTrigger>
      <DialogContent>
        <DialogHeader>Contact us</DialogHeader>
        <div className="mt-2 flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <Icon icon={EnvelopeIcon} className="size-10 min-w-[2.5rem] text-blue-500" />
            <Paragraph variant="base/bright">
              How can we help? We read every message and will respond as quickly as we can.
            </Paragraph>
          </div>
          <hr className="border-charcoal-800" />
          <Form method="post" action="/resources/feedback" {...form.props} className="w-full">
            <Fieldset className="max-w-full gap-y-3">
              <input value={location.pathname} {...conform.input(path, { type: "hidden" })} />
              <InputGroup className="max-w-full">
                {type === "feature" && (
                  <InfoPanel
                    icon={LightBulbIcon}
                    title="Did you know?"
                    panelClassName="w-full inline-flex mb-2"
                    to="https://feedback.trigger.dev"
                    buttonLabel="Submit feature request"
                  >
                    All our feature requests are public and voted on by the community. The best way
                    to submit your feature request is to post it to our feedback forum.
                  </InfoPanel>
                )}
                {type === "help" && (
                  <InfoPanel
                    icon={LightBulbIcon}
                    title="Did you know?"
                    panelClassName="w-full inline-flex mb-2"
                    to="https://trigger.dev/discord"
                    buttonLabel="Join our Discord"
                  >
                    Discord is the quickest way to get answers from the Trigger.dev team and
                    community.
                  </InfoPanel>
                )}
                <Select
                  {...conform.select(feedbackType)}
                  variant="tertiary/medium"
                  value={type}
                  defaultValue={type}
                  setValue={(v) => setType(v as FeedbackType)}
                  placeholder="Select type"
                  text={(value) => feedbackTypeLabel[value as FeedbackType]}
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
        </div>
      </DialogContent>
    </Dialog>
  );
}

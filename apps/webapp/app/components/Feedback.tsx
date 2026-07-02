import {
  getFormProps,
  getSelectProps,
  getInputProps,
  getTextareaProps,
  useForm,
} from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod";
import { InformationCircleIcon, ArrowUpCircleIcon } from "@heroicons/react/20/solid";
import { EnvelopeIcon, ShieldCheckIcon } from "@heroicons/react/24/solid";
import { Form, useActionData, useLocation, useNavigation, useSearchParams } from "@remix-run/react";
import { type ReactNode, useEffect, useState } from "react";
import { type FeedbackType, feedbackTypes, schema } from "~/routes/resources.feedback";
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
import { TextLink } from "./primitives/TextLink";
import { DialogClose } from "@radix-ui/react-dialog";

type FeedbackProps = {
  button: ReactNode;
  defaultValue?: FeedbackType;
  onOpenChange?: (open: boolean) => void;
};

export function Feedback({ button, defaultValue = "bug", onOpenChange }: FeedbackProps) {
  const [open, setOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const lastSubmission = useActionData();
  const navigation = useNavigation();
  const [type, setType] = useState<FeedbackType>(defaultValue);

  const [form, fields] = useForm({
    id: "accept-invite",
    lastResult: lastSubmission as any,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema });
    },
    shouldRevalidate: "onInput",
  });

  useEffect(() => {
    if (
      navigation.formAction === "/resources/feedback" &&
      navigation.state === "loading" &&
      Object.keys(form.allErrors).length === 0
    ) {
      setOpen(false);
    }
  }, [navigation.formAction, navigation.state, form.allErrors]);

  // Handle URL param functionality
  useEffect(() => {
    const open = searchParams.get("feedbackPanel");
    if (open) {
      setType(open as FeedbackType);
      setOpen(true);
      // Clone instead of mutating in place
      const next = new URLSearchParams(searchParams);
      next.delete("feedbackPanel");
      setSearchParams(next);
    }
  }, [searchParams]);

  const handleOpenChange = (value: boolean) => {
    setOpen(value);
    onOpenChange?.(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
          {!(
            type === "feature" ||
            type === "help" ||
            type === "concurrency" ||
            type === "hipaa"
          ) && <hr className="border-grid-dimmed" />}
          <Form
            method="post"
            action="/resources/feedback"
            {...getFormProps(form)}
            className="w-full"
          >
            <Fieldset className="max-w-full gap-y-3">
              <input
                value={location.pathname}
                {...getInputProps(fields.path, { type: "hidden" })}
              />
              <InputGroup className="max-w-full">
                {type === "feature" && (
                  <InfoPanel
                    icon={InformationCircleIcon}
                    iconClassName="text-blue-500"
                    panelClassName="w-full mb-2"
                  >
                    <Paragraph variant="small">
                      All our feature requests are public and voted on by the community. The best
                      way to submit your feature request is to{" "}
                      <TextLink to="https://feedback.trigger.dev">
                        post it to our feedback forum
                      </TextLink>
                      .
                    </Paragraph>
                  </InfoPanel>
                )}
                {type === "help" && (
                  <InfoPanel
                    icon={InformationCircleIcon}
                    iconClassName="text-blue-500"
                    panelClassName="w-full mb-2"
                  >
                    <Paragraph variant="small">
                      The quickest way to get answers from the Trigger.dev team and community is to{" "}
                      <TextLink to="https://trigger.dev/discord">ask in our Discord</TextLink>.
                    </Paragraph>
                  </InfoPanel>
                )}
                {type === "concurrency" && (
                  <InfoPanel
                    icon={ArrowUpCircleIcon}
                    iconClassName="text-indigo-500"
                    panelClassName="w-full mb-2"
                  >
                    <Paragraph variant="small">
                      How much extra concurrency do you need? You can add bundles of 50 for
                      $50/month each. To help us advise you, please let us know what your tasks do,
                      your typical run volume, and if your workload is spiky (many runs at once).
                    </Paragraph>
                  </InfoPanel>
                )}
                {type === "hipaa" && (
                  <InfoPanel
                    icon={ShieldCheckIcon}
                    iconClassName="text-green-500"
                    panelClassName="w-full mb-2"
                  >
                    <Paragraph variant="small">
                      We offer a signed Business Associate Agreement (BAA) as a paid add-on on any
                      paid plan. To help us get back to you quickly, please include your company
                      name, and a brief description of the PHI workload you plan to run.
                    </Paragraph>
                  </InfoPanel>
                )}
                <Select
                  {...getSelectProps(fields.feedbackType)}
                  variant="tertiary/medium"
                  value={type}
                  defaultValue={type}
                  setValue={(v) => setType(v as FeedbackType)}
                  placeholder="Select type"
                  text={(value) => feedbackTypes[value as FeedbackType].label}
                  dropdownIcon
                >
                  {Object.entries(feedbackTypes).map(([name, { label }]) => (
                    <SelectItem key={name} value={name}>
                      {label}
                    </SelectItem>
                  ))}
                </Select>
                <FormError id={fields.feedbackType.errorId}>{fields.feedbackType.errors}</FormError>
              </InputGroup>
              <InputGroup className="max-w-full">
                <Label>Message</Label>
                <TextArea {...getTextareaProps(fields.message)} />
                <FormError id={fields.message.errorId}>{fields.message.errors}</FormError>
              </InputGroup>
              <FormError>{form.errors}</FormError>
              <FormButtons
                confirmButton={
                  <Button type="submit" variant="primary/medium">
                    Send message
                  </Button>
                }
                cancelButton={
                  <DialogClose asChild>
                    <Button variant="tertiary/medium">Cancel</Button>
                  </DialogClose>
                }
              />
            </Fieldset>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

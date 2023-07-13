import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  Form,
  useActionData,
  useLocation,
  useNavigation,
} from "@remix-run/react";
import { ReactNode, useState } from "react";
import {
  FeedbackType,
  feedbackTypeLabel,
  schema,
} from "~/routes/resources.feedback";
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
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTrigger,
} from "./primitives/Sheet";
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
        <SheetHeader className="justify-between">Give us feedback</SheetHeader>
        <SheetBody>
          <Paragraph variant="small" className="mb-4">
            We'd love to hear your feedback, good, bad or ugly.
          </Paragraph>
          <Form method="post" action="/resources/feedback" {...form.props}>
            <Fieldset>
              <input
                value={location.pathname}
                {...conform.input(path, { type: "hidden" })}
              />
              <InputGroup>
                <Label>What kind of feedback do you have?</Label>
                <SelectGroup>
                  <Select
                    {...conform.input(feedbackType)}
                    defaultValue={defaultValue}
                  >
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
                <FormError id={feedbackType.errorId}>
                  {feedbackType.error}
                </FormError>
              </InputGroup>
              <InputGroup>
                <Label>Message</Label>
                <TextArea {...conform.textarea(message)} />
                <FormError id={message.errorId}>{message.error}</FormError>
              </InputGroup>
              <FormError>{form.error}</FormError>
              <FormButtons
                className="max-w-md"
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

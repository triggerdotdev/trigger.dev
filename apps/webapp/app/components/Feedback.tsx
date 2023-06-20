import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/solid";
import { Button } from "./primitives/Buttons";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTrigger,
} from "./primitives/Sheet";
import { Header1 } from "./primitives/Headers";
import { NamedIconInBox } from "./primitives/NamedIcon";
import { Paragraph } from "./primitives/Paragraph";
import {
  Form,
  useActionData,
  useLocation,
  useNavigation,
} from "@remix-run/react";
import { Fieldset } from "./primitives/Fieldset";
import { InputGroup } from "./primitives/InputGroup";
import { Label } from "./primitives/Label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./primitives/Select";
import { FormButtons } from "./primitives/FormButtons";
import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { schema } from "~/routes/resources.feedback";
import { FormError } from "./primitives/FormError";
import { Input } from "./primitives/Input";
import { TextArea } from "./primitives/TextArea";
import { useState } from "react";
import { set } from "jsonpointer";

export function Feedback() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const [form, { redirectPath, feedbackType, message }] = useForm({
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
      <SheetTrigger asChild={true}>
        <Button
          variant="secondary/small"
          LeadingIcon={ChatBubbleLeftRightIcon}
          shortcut={{ key: "f" }}
          onClick={() => console.log("feedback")}
        >
          Send us feedback
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader className="justify-between">Give us feedback</SheetHeader>
        <SheetBody>
          <Paragraph variant="small" className="mb-4">
            We'd love to hear your feedback, good, bad or ugly.
          </Paragraph>
          <Form method="post" action="/resources/feedback" {...form.props}>
            <Fieldset>
              <input
                value={location.pathname}
                {...conform.input(redirectPath, { type: "hidden" })}
              />
              <InputGroup>
                <Label>What kind of feedback do you have?</Label>
                <SelectGroup>
                  <Select {...conform.input(feedbackType)} defaultValue="bug">
                    <SelectTrigger size="medium" width="full">
                      <SelectValue placeholder="Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bug">Bug report</SelectItem>
                      <SelectItem value="feature">Feature request</SelectItem>
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

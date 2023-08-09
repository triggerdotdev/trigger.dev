import { conform, useForm, useInputEvent } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { useFetcher } from "@remix-run/react";
import { InlineCode } from "~/components/code/InlineCode";
import { Button, ButtonContent } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTrigger,
} from "~/components/primitives/Sheet";
import { TextLink } from "~/components/primitives/TextLink";
import { docsPath } from "~/utils/pathBuilder";
import { bodySchema } from "../resources.projects.$projectId.endpoint";
import { RuntimeEnvironment, RuntimeEnvironmentType } from "@trigger.dev/database";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { useRef, useState } from "react";

type FirstEndpointSheetProps = {
  projectId: string;
  environments: { id: string; type: RuntimeEnvironmentType }[];
};

export function FirstEndpointSheet({ projectId, environments }: FirstEndpointSheetProps) {
  const setEndpointUrlFetcher = useFetcher();
  const [form, { url, environmentId }] = useForm({
    id: "new-endpoint-url",
    lastSubmission: setEndpointUrlFetcher.data,
    onValidate({ formData }) {
      return parse(formData, { schema: bodySchema });
    },
  });

  const loadingEndpointUrl = setEndpointUrlFetcher.state !== "idle";

  return (
    <Sheet>
      <SheetTrigger>
        <ButtonContent variant={"primary/medium"}>Add your first endpoint</ButtonContent>
      </SheetTrigger>
      <SheetContent size="lg">
        <SheetHeader>
          <div>
            <Header1>Add your first endpoint</Header1>
            <Paragraph variant="small">
              We recommend you use{" "}
              <TextLink href={docsPath("documentation/guides/cli")}>the CLI</TextLink> when working
              in development.
            </Paragraph>
          </div>
        </SheetHeader>
        <SheetBody>
          <setEndpointUrlFetcher.Form
            method="post"
            action={`/resources/projects/${projectId}/endpoint`}
            {...form.props}
          >
            <InputGroup className="mb-4 max-w-none">
              <Header2>Environment type</Header2>
              <SelectGroup>
                <Select name={"environmentId"} defaultValue={environments[0].id}>
                  <SelectTrigger size="secondary/small">
                    <SelectValue placeholder="Select environment" className="m-0 p-0" /> Environment
                  </SelectTrigger>
                  <SelectContent>
                    {environments.map((environment) => (
                      <SelectItem key={environment.id} value={environment.id}>
                        <EnvironmentLabel environment={environment} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SelectGroup>
              <FormError id={environmentId.errorId}>{environmentId.error}</FormError>
            </InputGroup>
            <InputGroup className="max-w-none">
              <Header2>Endpoint URL</Header2>
              <div className="flex items-center">
                <Input
                  className="rounded-r-none"
                  {...conform.input(url, { type: "url" })}
                  placeholder="URL for your Trigger API route"
                />
                <Button
                  type="submit"
                  variant="primary/medium"
                  className="rounded-l-none"
                  disabled={loadingEndpointUrl}
                  LeadingIcon={loadingEndpointUrl ? "spinner-white" : undefined}
                >
                  {loadingEndpointUrl ? "Saving" : "Save"}
                </Button>
              </div>
              <FormError id={url.errorId}>{url.error}</FormError>
              <FormError id={form.errorId}>{form.error}</FormError>
              <Hint>
                This is the URL of your Trigger API route, Typically this would be:{" "}
                <InlineCode variant="extra-small">https://yourdomain.com/api/trigger</InlineCode>.
              </Hint>
            </InputGroup>
          </setEndpointUrlFetcher.Form>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

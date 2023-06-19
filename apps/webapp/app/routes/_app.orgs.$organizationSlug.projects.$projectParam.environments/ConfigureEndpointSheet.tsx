import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Header1, Header2 } from "~/components/primitives/Headers";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
} from "~/components/primitives/Sheet";
import { ClientEndpoint } from "~/presenters/EnvironmentsPresenter.server";
import { RuntimeEnvironmentType } from "../../../../../packages/database/src";
import { useFetcher } from "@remix-run/react";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Input } from "~/components/primitives/Input";
import { Button } from "~/components/primitives/Buttons";
import { Label } from "~/components/primitives/Label";
import { Hint } from "~/components/primitives/Hint";
import { InlineCode } from "~/components/code/InlineCode";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Callout } from "~/components/primitives/Callout";
import { formatDateTime } from "~/utils";
import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { bodySchema } from "../resources.environments.$environmentParam.endpoint";
import { FormError } from "~/components/primitives/FormError";

type ConfigureEndpointSheetProps = {
  slug: string;
  endpoint: ClientEndpoint;
  type: RuntimeEnvironmentType;
  onClose: () => void;
};

export function ConfigureEndpointSheet({
  slug,
  endpoint,
  onClose,
}: ConfigureEndpointSheetProps) {
  const setEndpointUrlFetcher = useFetcher();

  const [form, { url, clientSlug }] = useForm({
    id: "endpoint-url",
    lastSubmission: setEndpointUrlFetcher.data,
    onValidate({ formData }) {
      return parse(formData, { schema: bodySchema });
    },
  });
  const loadingEndpointUrl = setEndpointUrlFetcher.state !== "idle";

  console.log("endpoint", endpoint);

  return (
    <Sheet
      open={true}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent>
        <SheetHeader>
          <Header1>
            <div className="flex items-center gap-2">
              <EnvironmentLabel
                environment={{ type: endpoint.environment.type }}
              />
              <Header1>Configure endpoint</Header1>
            </div>
          </Header1>
        </SheetHeader>
        <SheetBody>
          <setEndpointUrlFetcher.Form
            method="post"
            action={`/resources/environments/${endpoint.environment.id}/endpoint`}
            {...form.props}
          >
            <InputGroup className="max-w-none">
              <Label>Endpoint URL</Label>
              <div className="flex items-center">
                <input
                  {...conform.input(clientSlug, { type: "hidden" })}
                  value={slug}
                />
                <Input
                  className="rounded-r-none"
                  {...conform.input(url, { type: "url" })}
                  defaultValue={"url" in endpoint ? endpoint.url : ""}
                  placeholder="Path to your Trigger API route"
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
                This is the URL of your Trigger API route, Typically this would
                be:{" "}
                <InlineCode variant="extra-small">
                  https://yourdomain.com/api/trigger
                </InlineCode>
                .
              </Hint>
            </InputGroup>
          </setEndpointUrlFetcher.Form>

          {endpoint.state === "configured" && (
            <div className="mt-4 flex flex-col">
              <div>
                <Header2>Status</Header2>
                <Paragraph>
                  We connect to your endpoint and refresh your Jobs.
                </Paragraph>
                <Callout variant="success">
                  Endpoint configured. Last refreshed:{" "}
                  {endpoint.latestIndex
                    ? formatDateTime(endpoint.latestIndex.updatedAt)
                    : "–"}
                </Callout>
              </div>
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

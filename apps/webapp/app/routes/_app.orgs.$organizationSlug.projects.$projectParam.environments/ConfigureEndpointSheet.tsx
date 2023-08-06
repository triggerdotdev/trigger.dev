import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { useFetcher, useRevalidator } from "@remix-run/react";
import { useEffect } from "react";
import { useEventSource } from "remix-utils";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime } from "~/components/primitives/DateTime";
import { FormError } from "~/components/primitives/FormError";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Sheet, SheetBody, SheetContent, SheetHeader } from "~/components/primitives/Sheet";
import { ClientEndpoint } from "~/presenters/EnvironmentsPresenter.server";
import { endpointStreamingPath } from "~/utils/pathBuilder";
import { RuntimeEnvironmentType } from "../../../../../packages/database/src";
import { bodySchema } from "../resources.environments.$environmentParam.endpoint";

type ConfigureEndpointSheetProps = {
  slug: string;
  endpoint: ClientEndpoint;
  type: RuntimeEnvironmentType;
  onClose: () => void;
};

export function ConfigureEndpointSheet({ slug, endpoint, onClose }: ConfigureEndpointSheetProps) {
  const setEndpointUrlFetcher = useFetcher();

  const [form, { url, clientSlug }] = useForm({
    id: "endpoint-url",
    lastSubmission: setEndpointUrlFetcher.data,
    onValidate({ formData }) {
      return parse(formData, { schema: bodySchema });
    },
  });
  const loadingEndpointUrl = setEndpointUrlFetcher.state !== "idle";

  const refreshEndpointFetcher = useFetcher();
  const refreshingEndpoint = refreshEndpointFetcher.state !== "idle";

  const revalidator = useRevalidator();
  const events = useEventSource(endpointStreamingPath({ id: endpoint.environment.id }), {
    event: "message",
  });

  useEffect(() => {
    if (events !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Sheet
      open={true}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent size="lg">
        <SheetHeader>
          <Header1>
            <div className="flex items-center gap-2">
              <EnvironmentLabel environment={{ type: endpoint.environment.type }} />
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
              <Header2>Endpoint URL</Header2>
              <div className="flex items-center">
                <input {...conform.input(clientSlug, { type: "hidden" })} value={slug} />
                <Input
                  className="rounded-r-none"
                  {...conform.input(url, { type: "url" })}
                  defaultValue={"url" in endpoint ? endpoint.url : ""}
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

          {endpoint.state === "configured" && (
            <div className="mt-4 flex flex-col gap-4">
              <div>
                <Header2>Status</Header2>
                <Paragraph className="mb-2" variant="small">
                  We connect to your endpoint and refresh your Jobs.
                </Paragraph>
                <refreshEndpointFetcher.Form
                  method="post"
                  action={`/resources/environments/${endpoint.environment.id}/endpoint/${endpoint.id}`}
                >
                  <Callout variant="success" className="justiy-between items-center">
                    <Paragraph variant="small" className="grow text-green-200">
                      Endpoint configured. Last refreshed:{" "}
                      {endpoint.latestIndex ? (
                        <DateTime date={endpoint.latestIndex.updatedAt} />
                      ) : (
                        "–"
                      )}
                    </Paragraph>
                    <Button
                      variant="primary/small"
                      type="submit"
                      className="bg-green-700 group-hover:bg-green-600/90"
                      disabled={refreshingEndpoint}
                      LeadingIcon={refreshingEndpoint ? "spinner-white" : undefined}
                    >
                      {refreshingEndpoint ? "Refreshing" : "Refresh now"}
                    </Button>
                  </Callout>
                </refreshEndpointFetcher.Form>
              </div>
              <div className="max-w-full overflow-hidden">
                <Header2>Automatic refreshing</Header2>
                <Paragraph className="mb-2" variant="small">
                  Use this webhook URL so your Jobs get automatically refreshed when you deploy. You
                  just need to hit this URL (POST) and we will refresh your Jobs.
                </Paragraph>
                <ClipboardField variant="secondary/medium" value={endpoint.indexWebhookPath} />
              </div>
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

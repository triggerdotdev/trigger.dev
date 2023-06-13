import { Form } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { JSONEditor } from "~/components/code/JSONEditor";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "~/components/primitives/Popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { TestJobPresenter } from "~/presenters/TestJobPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { JobParamsSchema, ProjectParamSchema } from "~/utils/pathBuilder";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Callout } from "~/components/primitives/Callout";
import { PopoverTrigger } from "@radix-ui/react-popover";
import { Button, ButtonContent } from "~/components/primitives/Buttons";
import { set } from "lodash";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, jobParam } =
    JobParamsSchema.parse(params);

  const presenter = new TestJobPresenter();
  const { environments } = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    jobSlug: jobParam,
  });

  return typedjson({ environments });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "test",
  },
};

//create an Action
//save the chosen environment to a cookie (for that user), use it to default the env dropdown
//create a TestEventService class
// 1. create an EventRecord
// 2. Then use CreateRun. Update it so call can accept an optional transaction (that it uses)
// 3. It should return the run, so we can redirect to the run page

const startingJson = "{\n\n}";

export default function Page() {
  const [isExamplePopoverOpen, setIsExamplePopoverOpen] = useState(false);
  const { environments } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  const [defaultJson, setDefaultJson] = useState<string>(startingJson);
  const currentJson = useRef<string>(defaultJson);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>(
    environments[0].id
  );

  const selectedEnvironment = environments.find(
    (e) => e.id === selectedEnvironmentId
  );

  const insertCode = useCallback((code: string) => {
    setDefaultJson(code);
    setIsExamplePopoverOpen(false);
  }, []);

  if (environments.length === 0) {
    return (
      <Callout variant="warning">
        Can't run a test when there are no environments. This shouldn't happen,
        please contact support.
      </Callout>
    );
  }

  return (
    <div>
      <Form className="flex flex-col gap-2" method="post">
        <div className="flex items-center justify-between">
          <SelectGroup>
            <Select
              name="environment"
              value={selectedEnvironmentId}
              onValueChange={setSelectedEnvironmentId}
            >
              <SelectTrigger size="medium">
                Environment: <SelectValue placeholder="Select environment" />
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

          <Popover
            open={isExamplePopoverOpen}
            onOpenChange={(open) => setIsExamplePopoverOpen(open)}
          >
            <PopoverTrigger>
              <ButtonContent
                variant="secondary/medium"
                TrailingIcon="chevron-down"
              >
                Insert example
              </ButtonContent>
            </PopoverTrigger>

            <PopoverContent className="w-80 p-0" align="start">
              {selectedEnvironment?.examples.map((example) => (
                <Button
                  key={example.id}
                  variant="menu-item"
                  onClick={(e) => insertCode(example.payload)}
                  LeadingIcon={example.icon ?? undefined}
                  fullWidth
                  textAlignLeft
                >
                  {example.name}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        </div>

        <JSONEditor
          defaultValue={defaultJson}
          readOnly={false}
          basicSetup
          onChange={(v) => (currentJson.current = v)}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="primary/medium">
            Run test
          </Button>
        </div>
      </Form>
    </div>
  );
}

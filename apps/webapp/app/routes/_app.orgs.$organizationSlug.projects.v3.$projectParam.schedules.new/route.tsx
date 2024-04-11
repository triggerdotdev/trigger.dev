import { PlusIcon } from "@heroicons/react/20/solid";
import { Form, Outlet, useLocation, useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { BlankstateInstructions } from "~/components/BlankstateInstructions";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";
import { ResizablePanel, ResizablePanelGroup } from "~/components/primitives/Resizable";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";
import { ScheduleFilters, ScheduleListFilters } from "~/components/runs/v3/ScheduleFilters";
import { useEnvironments } from "~/hooks/useEnvironments";
import { useOrganization } from "~/hooks/useOrganizations";
import { usePathName } from "~/hooks/usePathName";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { EditSchedulePresenter } from "~/presenters/v3/EditSchedulePresenter.server";
import { ScheduleListPresenter } from "~/presenters/v3/ScheduleListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  ProjectParamSchema,
  docsPath,
  v3NewSchedulePath,
  v3SchedulesPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const presenter = new EditSchedulePresenter();
  const result = await presenter.call({
    userId,
    projectSlug: projectParam,
  });

  return typedjson(result);
};

export default function Page() {
  const { schedule, possibleTasks, possibleEnvironments } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const environments = useEnvironments();
  const project = useProject();
  const location = useLocation();
  const currentUser = useUser();

  return (
    <Form
      method="POST"
      className="grid h-full max-h-full grid-rows-[2.5rem_1fr_2.5rem] overflow-hidden bg-background-bright"
    >
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>New schedule</Header2>
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="p-3">
          <Fieldset>
            <InputGroup>
              <Label>Task</Label>
              <SelectGroup>
                <Select name="tasks" defaultValue={schedule?.taskIdentifier}>
                  <SelectTrigger size="medium" width="full">
                    <SelectValue placeholder="Select task" className="ml-2 p-0" />
                  </SelectTrigger>
                  <SelectContent>
                    {possibleTasks.map((task) => (
                      <SelectItem key={task} value={task}>
                        <Paragraph
                          variant="extra-small"
                          className="pl-0.5 transition group-hover:text-text-bright"
                        >
                          {task}
                        </Paragraph>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SelectGroup>
            </InputGroup>
            <InputGroup>
              <Label>CRON pattern</Label>
              <Input
                name="cron"
                placeholder="? ? ? ? ?"
                required={true}
                defaultValue={schedule?.cron}
              />
              <Hint>Enter a CRON pattern or use natural language above.</Hint>
            </InputGroup>
            <InputGroup>
              <Label>Environments</Label>
              <RadioGroup name="environments" className="flex flex-wrap items-center gap-2">
                {possibleEnvironments.map((environment) => (
                  <RadioGroupItem
                    id={environment.id}
                    label={
                      <EnvironmentLabel environment={environment} userName={environment.userName} />
                    }
                    value={environment.id}
                    variant="button"
                  />
                ))}
              </RadioGroup>
              <Hint>Enter a CRON pattern or use natural language above.</Hint>
            </InputGroup>
          </Fieldset>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-2">
        <div className="flex items-center gap-4">
          <LinkButton
            to={`${v3SchedulesPath(organization, project)}${location.search}`}
            variant="minimal/small"
          >
            Cancel
          </LinkButton>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="primary/small" type="submit">
            Create schedule
          </Button>
        </div>
      </div>
    </Form>
  );
}

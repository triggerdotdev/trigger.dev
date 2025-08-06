import {
  ArrowRightIcon,
  BookOpenIcon,
  ChatBubbleLeftEllipsisIcon,
  MapPinIcon,
} from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { CloudProviderIcon } from "~/assets/icons/CloudProviderIcon";
import { FlagIcon } from "~/assets/icons/RegionIcons";
import { cloudProviderTitle } from "~/components/CloudProvider";
import { Feedback } from "~/components/Feedback";
import { V4Title } from "~/components/V4Badge";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyableText } from "~/components/primitives/CopyableText";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextLink } from "~/components/primitives/TextLink";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { type Region, RegionsPresenter } from "~/presenters/v3/RegionsPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  docsPath,
  EnvironmentParamSchema,
  ProjectParamSchema,
  regionsPath,
} from "~/utils/pathBuilder";
import { SetDefaultRegionService } from "~/v3/services/setDefaultRegion.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  const presenter = new RegionsPresenter();
  const [error, result] = await tryCatch(
    presenter.call({
      userId,
      projectSlug: projectParam,
    })
  );

  if (error) {
    throw new Response(undefined, {
      status: 400,
      statusText: error.message,
    });
  }

  return typedjson(result);
};

const FormSchema = z.object({
  regionId: z.string(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  const redirectPath = regionsPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam }
  );

  if (!project) {
    throw redirectWithErrorMessage(redirectPath, request, "Project not found");
  }

  const formData = await request.formData();
  const parsedFormData = FormSchema.safeParse(Object.fromEntries(formData));

  if (!parsedFormData.success) {
    throw redirectWithErrorMessage(redirectPath, request, "No region specified");
  }

  const service = new SetDefaultRegionService();
  const [error, result] = await tryCatch(
    service.call({
      projectId: project.id,
      regionId: parsedFormData.data.regionId,
    })
  );

  if (error) {
    return redirectWithErrorMessage(redirectPath, request, error.message);
  }

  return redirectWithSuccessMessage(redirectPath, request, `Set ${result.name} as default`);
};

export default function Page() {
  const { regions } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={<V4Title>Regions</V4Title>} />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              {regions.map((region) => (
                <Property.Item key={region.id}>
                  <Property.Label>{region.name}</Property.Label>
                  <Property.Value>{region.id}</Property.Value>
                </Property.Item>
              ))}
            </Property.Table>
          </AdminDebugTooltip>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full min-h-full grid-rows-[1fr]">
          {regions.length === 0 ? (
            <MainCenteredContainer className="max-w-md">
              <div className="text-center">
                <Paragraph>No regions found for this project.</Paragraph>
              </div>
            </MainCenteredContainer>
          ) : (
            <>
              <div className="grid max-h-full min-h-full grid-rows-[1fr] overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Region</TableHeaderCell>
                      <TableHeaderCell>Cloud Provider</TableHeaderCell>
                      <TableHeaderCell>Location</TableHeaderCell>
                      <TableHeaderCell>Static IPs</TableHeaderCell>
                      <TableHeaderCell
                        alignment="right"
                        tooltip={
                          <div className="max-w-[12rem]">
                            <Paragraph variant="small">
                              When you trigger a run it will execute in your default region, unless
                              you override the region when triggering.
                            </Paragraph>
                            <LinkButton
                              variant="docs/small"
                              LeadingIcon={BookOpenIcon}
                              to={docsPath("triggering#region")}
                              className="mb-1 mt-3"
                            >
                              Read docs
                            </LinkButton>
                          </div>
                        }
                      >
                        Default region
                      </TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {regions.length === 0 ? (
                      <TableBlankRow colSpan={5}>
                        <Paragraph>There are no regions for this project</Paragraph>
                      </TableBlankRow>
                    ) : (
                      regions.map((region) => {
                        return (
                          <TableRow key={region.id}>
                            <TableCell isTabbableCell>
                              <CopyableText value={region.name} />
                            </TableCell>
                            <TableCell>
                              {region.cloudProvider ? (
                                <span className="flex items-center gap-2">
                                  <CloudProviderIcon
                                    provider={region.cloudProvider}
                                    className="size-6"
                                  />
                                  {cloudProviderTitle(region.cloudProvider)}
                                </span>
                              ) : (
                                "–"
                              )}
                            </TableCell>
                            <TableCell>
                              <span className="flex items-center gap-2">
                                {region.location ? (
                                  <FlagIcon region={region.location} className="size-5" />
                                ) : null}
                                {region.description ?? "–"}
                              </span>
                            </TableCell>
                            <TableCell>
                              {region.staticIPs ? (
                                <ClipboardField
                                  value={region.staticIPs}
                                  variant={"secondary/small"}
                                />
                              ) : (
                                "Not available"
                              )}
                            </TableCell>
                            {region.isDefault ? (
                              <TableCell alignment="right">
                                <Badge variant="small" className="inline-grid">
                                  Default
                                </Badge>
                              </TableCell>
                            ) : (
                              <TableCellMenu
                                className="pl-32"
                                isSticky
                                visibleButtons={
                                  <SetDefaultDialog regions={regions} newDefaultRegion={region} />
                                }
                              />
                            )}
                          </TableRow>
                        );
                      })
                    )}
                    <TableRow className="h-[3.125rem]">
                      <TableCell colSpan={4}>
                        <Paragraph variant="extra-small">Suggest a new region</Paragraph>
                      </TableCell>
                      <TableCellMenu
                        alignment="right"
                        isSticky
                        visibleButtons={
                          <Feedback
                            button={
                              <Button
                                variant="secondary/small"
                                LeadingIcon={ChatBubbleLeftEllipsisIcon}
                                leadingIconClassName="text-indigo-500"
                              >
                                Suggest a region…
                              </Button>
                            }
                            defaultValue="region"
                          />
                        }
                      />
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}

function SetDefaultDialog({
  regions,
  newDefaultRegion,
}: {
  regions: Region[];
  newDefaultRegion: Region;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const currentDefaultRegion = regions.find((r) => r.isDefault);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          variant="secondary/small"
          LeadingIcon={MapPinIcon}
          leadingIconClassName="text-blue-500"
          iconSpacing="gap-2"
          className="pl-2"
        >
          Set as default…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set as default region</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          <Paragraph>
            Are you sure you want to set {newDefaultRegion.name} as your new default region?
          </Paragraph>

          <div className="my-4 flex">
            <div className="flex flex-1 flex-col rounded-md border border-grid-dimmed">
              <div className="border-b border-grid-dimmed bg-charcoal-800 p-3 font-medium">
                <Paragraph variant="small/bright">Current default</Paragraph>
              </div>
              <div className="border-b border-grid-dimmed p-3">
                <Paragraph variant="small">{currentDefaultRegion?.name ?? "–"}</Paragraph>
              </div>
              <div className="border-b border-grid-dimmed p-3">
                <Paragraph variant="small" className="flex items-center gap-2">
                  {currentDefaultRegion?.cloudProvider ? (
                    <>
                      <CloudProviderIcon
                        provider={currentDefaultRegion.cloudProvider}
                        className="size-6"
                      />
                      {cloudProviderTitle(currentDefaultRegion.cloudProvider)}
                    </>
                  ) : (
                    "–"
                  )}
                </Paragraph>
              </div>
              <div className="p-3">
                <Paragraph variant="small" className="flex items-center gap-2">
                  {currentDefaultRegion?.location ? (
                    <FlagIcon region={currentDefaultRegion.location} className="size-5" />
                  ) : null}
                  {currentDefaultRegion?.description ?? "–"}
                </Paragraph>
              </div>
            </div>

            {/* Middle column with arrow */}
            <div className="flex items-center justify-center px-3">
              <div className="flex size-10 items-center justify-center rounded-full border border-grid-dimmed bg-charcoal-800 p-2">
                <ArrowRightIcon className="size-4 text-text-dimmed" />
              </div>
            </div>

            {/* Right column */}
            <div className="flex flex-1 flex-col rounded-md border border-grid-dimmed">
              <div className="border-b border-grid-dimmed bg-charcoal-800 p-3 font-medium">
                <Paragraph variant="small/bright">New default</Paragraph>
              </div>
              <div className="border-b border-grid-dimmed p-3">
                <Paragraph variant="small">{newDefaultRegion.name}</Paragraph>
              </div>
              <div className="border-b border-grid-dimmed p-3">
                <Paragraph variant="small" className="flex items-center gap-2">
                  {newDefaultRegion.cloudProvider ? (
                    <>
                      <CloudProviderIcon
                        provider={newDefaultRegion.cloudProvider}
                        className="size-6"
                      />
                      {cloudProviderTitle(newDefaultRegion.cloudProvider)}
                    </>
                  ) : (
                    "–"
                  )}
                </Paragraph>
              </div>
              <div className="p-3">
                <Paragraph variant="small" className="flex items-center gap-2">
                  {newDefaultRegion.location ? (
                    <FlagIcon region={newDefaultRegion.location} className="size-5" />
                  ) : null}
                  {newDefaultRegion.description ?? "–"}
                </Paragraph>
              </div>
            </div>
          </div>

          <Paragraph>
            Runs triggered from now on will execute in "{newDefaultRegion.name}", unless you{" "}
            <TextLink to={docsPath("triggering#region")}>override when triggering</TextLink>.
          </Paragraph>
        </DialogDescription>
        <DialogFooter>
          <Button variant="secondary/medium" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Form method="post">
            <Button
              variant="primary/medium"
              type="submit"
              name="regionId"
              shortcut={{ modifiers: ["mod"], key: "enter" }}
              value={newDefaultRegion.id}
            >
              Set as default
            </Button>
          </Form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

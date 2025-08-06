import { Form } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { CloudProviderIcon } from "~/assets/icons/CloudProviderIcon";
import { FlagIcon } from "~/assets/icons/RegionIcons";
import { cloudProviderTitle } from "~/components/CloudProvider";
import { V4Title } from "~/components/V4Badge";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
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

export const RegionsOptions = z.object({
  search: z.string().optional(),
  page: z.preprocess((val) => Number(val), z.number()).optional(),
});

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
                          <Paragraph variant="small">
                            When you trigger a run it will execute in your default region, unless
                            you{" "}
                            <TextLink to={docsPath("triggering#region")}>
                              specify a region when triggering
                            </TextLink>
                            .
                          </Paragraph>
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
                            <TableCellMenu
                              className="pl-32"
                              isSticky
                              visibleButtons={
                                region.isDefault ? (
                                  <Badge variant="outline-rounded" className="inline-grid">
                                    Default
                                  </Badge>
                                ) : (
                                  <SetDefaultDialog region={region} />
                                )
                              }
                            />
                          </TableRow>
                        );
                      })
                    )}
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

function SetDefaultDialog({ region }: { region: Region }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary/small">Set as default...</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set as default</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          <Paragraph>
            When you trigger a run it will execute in your default region, unless you{" "}
            <TextLink to={docsPath("triggering#region")}>specify a region when triggering</TextLink>
            .
          </Paragraph>
        </DialogDescription>
        <DialogFooter>
          <Button variant="secondary/small" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Form method="post">
            <Button variant="secondary/small" type="submit" name="regionId" value={region.id}>
              Set as default
            </Button>
          </Form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

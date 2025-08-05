import { BookOpenIcon } from "@heroicons/react/24/solid";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { CloudProviderIcon } from "~/assets/icons/CloudProviderIcon";
import { FlagIcon } from "~/assets/icons/RegionIcons";
import { cloudProviderTitle } from "~/components/CloudProvider";
import { V4Title } from "~/components/V4Badge";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyableText } from "~/components/primitives/CopyableText";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
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
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { RegionsPresenter } from "~/presenters/v3/RegionsPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, ProjectParamSchema } from "~/utils/pathBuilder";

export const RegionsOptions = z.object({
  search: z.string().optional(),
  page: z.preprocess((val) => Number(val), z.number()).optional(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  const searchParams = new URL(request.url).searchParams;
  const parsedSearchParams = RegionsOptions.safeParse(Object.fromEntries(searchParams));
  const options = parsedSearchParams.success ? parsedSearchParams.data : {};

  try {
    const presenter = new RegionsPresenter();
    const result = await presenter.call({
      userId,
      projectSlug: projectParam,
    });

    return typedjson(result);
  } catch (error) {
    logger.error("Error loading regions page", { error });
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const { regions } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

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

          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("deployment/preview-branches")}
          >
            Regions docs
          </LinkButton>
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
                      <TableHeaderCell>
                        <span className="sr-only">Is default?</span>
                      </TableHeaderCell>
                      <TableHeaderCell>
                        <span className="sr-only">Actions</span>
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
                                  <FlagIcon
                                    region={region.location}
                                    className="aspect-auto h-3 w-4"
                                  />
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
                                "–"
                              )}
                            </TableCell>
                            <TableCell>
                              {region.isDefault ? (
                                <Badge variant="outline-rounded" className="inline-grid">
                                  Default
                                </Badge>
                              ) : (
                                "–"
                              )}
                            </TableCell>
                            <TableCellMenu
                              className="pl-32"
                              isSticky
                              popoverContent={
                                <PopoverMenuItem to="#" title="View region details" />
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

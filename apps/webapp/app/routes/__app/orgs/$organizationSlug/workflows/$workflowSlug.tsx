import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import {
  ManualWebhookSourceSchema,
  TriggerMetadataSchema,
} from "@trigger.dev/common-schemas";
import {
  DisplayProperties,
  DisplayPropertiesSchema,
} from "@trigger.dev/integration-sdk";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Container } from "~/components/layout/Container";
import {
  SideMenuContainer,
  WorkflowsSideMenu,
} from "~/components/navigation/SideMenu";
import { getConnectedApiConnectionsForOrganizationSlug } from "~/models/apiConnection.server";
import { buildExternalSourceUrl } from "~/models/externalSource.server";
import { getServiceMetadatas } from "~/models/integrations.server";
import { getWorkflowFromSlugs } from "~/models/workflow.server";
import { analytics } from "~/services/analytics.server";
import { requireUser } from "~/services/session.server";

type ExternalSourceConfig =
  | ExternalSourceIntegrationConfig
  | ExternalSourceManualConfig;

type ExternalSourceIntegrationConfig = {
  type: "integration";
  url: string;
};

type ExternalSourceManualConfig = {
  type: "manual";
  data: ManualConfigDataSuccess | ManualConfigDataError;
};

type ManualConfigDataError = {
  success: false;
  error: string;
};

type ManualConfigDataSuccess = {
  success: true;
  url: string;
  secret?: string;
};

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, workflowSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");
  invariant(workflowSlug, "workflowSlug not found");

  let workflow = await getWorkflowFromSlugs({
    userId: user.id,
    organizationSlug,
    workflowSlug,
  });

  if (workflow === null) {
    throw new Response("Not Found", { status: 404 });
  }

  analytics.workflow.identify({ workflow });

  const servicesMetadatas = await getServiceMetadatas(user.admin);

  const rules = workflow.rules.map((r) => ({
    ...r,
    trigger: TriggerMetadataSchema.parse(r.trigger),
  }));

  const allConnections = await getConnectedApiConnectionsForOrganizationSlug({
    slug: organizationSlug,
  });

  const externalSourceService = workflow?.externalSource?.service;

  const externalSourceServiceMetadata = externalSourceService
    ? servicesMetadatas[externalSourceService]
    : undefined;
  const externalSourceSlot =
    workflow.externalSource && externalSourceServiceMetadata
      ? {
          ...workflow.externalSource,
          possibleConnections: allConnections.filter(
            (a) => a.apiIdentifier === workflow?.externalSource?.service
          ),
          integration: externalSourceServiceMetadata,
        }
      : undefined;

  const connectionSlots = {
    source: externalSourceSlot,
    services: workflow.externalServices.flatMap((c) => {
      const serviceMetadata = servicesMetadatas[c.service];

      if (!serviceMetadata) {
        return [];
      }

      return {
        ...c,
        possibleConnections: allConnections.filter(
          (a) => a.apiIdentifier === c.service
        ),
        integration: serviceMetadata,
      };
    }),
  };

  let externalSourceConfig: ExternalSourceConfig | undefined = undefined;

  if (workflow.externalSource && !workflow.externalSource.manualRegistration) {
    externalSourceConfig = {
      type: "integration",
      url: buildExternalSourceUrl(
        workflow.externalSource.id,
        workflow.externalSource.service
      ),
    };
  } else if (
    workflow.externalSource &&
    workflow.externalSource.manualRegistration
  ) {
    const parsedManualWebhook = ManualWebhookSourceSchema.safeParse(
      workflow.externalSource.source
    );
    if (parsedManualWebhook.success) {
      externalSourceConfig = {
        type: "manual",
        data: {
          success: true,
          url: buildExternalSourceUrl(
            workflow.externalSource.id,
            workflow.externalSource.service
          ),
          secret: parsedManualWebhook.data.verifyPayload.enabled
            ? workflow.externalSource.secret ?? undefined
            : undefined,
        },
      };
    } else {
      externalSourceConfig = {
        type: "manual",
        data: {
          success: false,
          error: parsedManualWebhook.error.message,
        },
      };
    }
  }

  //external source displayProperties
  const parsedDisplayProperties = DisplayPropertiesSchema.safeParse(
    workflow.externalSource?.displayProperties
  );
  let triggerDisplayProperties: DisplayProperties | undefined = undefined;
  if (parsedDisplayProperties.success) {
    triggerDisplayProperties = parsedDisplayProperties.data;
  }

  return typedjson({
    workflow: {
      ...workflow,
      rules,
      externalSourceConfig,
      triggerDisplayProperties,
    },
    connectionSlots,
  });
};

export default function Page() {
  return (
    <>
      <SideMenuContainer>
        <WorkflowsSideMenu />
        <Container>
          <Outlet />
        </Container>
      </SideMenuContainer>
    </>
  );
}

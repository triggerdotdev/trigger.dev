import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData, useParams, type MetaFunction } from "@remix-run/react";
import { json, type ActionFunction, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { useState } from "react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { canAccessPrivateConnections } from "~/v3/canAccessPrivateConnections.server";
import {
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import type { CreatePrivateLinkConnectionBody } from "@trigger.dev/platform";
import {
  createPrivateLink,
  getPrivateLinkRegions,
} from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import {
  OrganizationParamsSchema,
  organizationPath,
  v3PrivateConnectionsPath,
} from "~/utils/pathBuilder";
import {
  CommandLineIcon,
  DocumentTextIcon,
  PencilSquareIcon,
  SparklesIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";

export const meta: MetaFunction = () => {
  return [{ title: `Add Private Connection | Trigger.dev` }];
};

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const canAccess = await canAccessPrivateConnections({ organizationSlug, userId });
  if (!canAccess) {
    return redirect(organizationPath({ slug: organizationSlug }));
  }

  const organization = await prisma.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId } } },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  const [error, regions] = await tryCatch(getPrivateLinkRegions(organization.id));

  const awsAccountIds = env.PRIVATE_CONNECTIONS_AWS_ACCOUNT_IDS?.split(",").filter(Boolean) ?? [];

  return typedjson({
    availableRegions: regions?.availableRegions ?? ["us-east-1", "eu-central-1"],
    activeRegions: regions?.activeRegions ?? [],
    awsAccountIds,
  });
}

const schema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name must be 100 characters or less"),
  endpointServiceName: z
    .string()
    .min(1, "VPC Endpoint Service name is required")
    .regex(
      /^com\.amazonaws\.vpce\..+\.vpce-svc-.+$/,
      "Must be a valid VPC Endpoint Service name (com.amazonaws.vpce.<region>.vpce-svc-*)"
    ),
  targetRegion: z.string().min(1, "Region is required"),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  const organization = await prisma.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId } } },
  });

  if (!organization) {
    return redirectWithErrorMessage(
      v3PrivateConnectionsPath({ slug: organizationSlug }),
      request,
      "Organization not found"
    );
  }

  // Fetch available regions dynamically (same call the loader makes)
  const [, fetchedRegions] = await tryCatch(getPrivateLinkRegions(organization.id));
  const availableRegions = fetchedRegions?.availableRegions ?? ["us-east-1", "eu-central-1"];

  const { targetRegion: selectedRegion, ...rest } = submission.value;

  if (!availableRegions.includes(selectedRegion)) {
    return redirectWithErrorMessage(
      v3PrivateConnectionsPath({ slug: organizationSlug }),
      request,
      `Invalid region: ${selectedRegion}`
    );
  }

  const [error] = await tryCatch(
    createPrivateLink(organization.id, {
      ...rest,
      targetRegion: selectedRegion as CreatePrivateLinkConnectionBody["targetRegion"],
    })
  );

  if (error) {
    return redirectWithErrorMessage(
      v3PrivateConnectionsPath({ slug: organizationSlug }),
      request,
      error.message
    );
  }

  const message = "Connection created! Provisioning will begin shortly.";

  return redirectWithSuccessMessage(
    v3PrivateConnectionsPath({ slug: organizationSlug }),
    request,
    message
  );
};


type SetupMethod = "manual" | "ai" | "terraform" | "docs";

type PortEntry = { port: string; protocol: "TCP" | "UDP" };

const AWS_REGIONS = [
  { value: "us-east-1", label: "US East (N. Virginia)" },
  { value: "us-east-2", label: "US East (Ohio)" },
  { value: "us-west-1", label: "US West (N. California)" },
  { value: "us-west-2", label: "US West (Oregon)" },
  { value: "af-south-1", label: "Africa (Cape Town)" },
  { value: "ap-east-1", label: "Asia Pacific (Hong Kong)" },
  { value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
  { value: "ap-south-2", label: "Asia Pacific (Hyderabad)" },
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
  { value: "ap-southeast-3", label: "Asia Pacific (Jakarta)" },
  { value: "ap-southeast-4", label: "Asia Pacific (Melbourne)" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
  { value: "ap-northeast-2", label: "Asia Pacific (Seoul)" },
  { value: "ap-northeast-3", label: "Asia Pacific (Osaka)" },
  { value: "ca-central-1", label: "Canada (Central)" },
  { value: "ca-west-1", label: "Canada West (Calgary)" },
  { value: "eu-central-1", label: "Europe (Frankfurt)" },
  { value: "eu-central-2", label: "Europe (Zurich)" },
  { value: "eu-west-1", label: "Europe (Ireland)" },
  { value: "eu-west-2", label: "Europe (London)" },
  { value: "eu-west-3", label: "Europe (Paris)" },
  { value: "eu-south-1", label: "Europe (Milan)" },
  { value: "eu-south-2", label: "Europe (Spain)" },
  { value: "eu-north-1", label: "Europe (Stockholm)" },
  { value: "il-central-1", label: "Israel (Tel Aviv)" },
  { value: "me-south-1", label: "Middle East (Bahrain)" },
  { value: "me-central-1", label: "Middle East (UAE)" },
  { value: "sa-east-1", label: "South America (São Paulo)" },
];

function TerraformWizard({ awsAccountIds }: { awsAccountIds: string[] }) {
  const [hostname, setHostname] = useState("");
  const [ports, setPorts] = useState<PortEntry[]>([{ port: "5432", protocol: "TCP" }]);
  const [region, setRegion] = useState("us-east-1");

  const addPort = () => setPorts([...ports, { port: "", protocol: "TCP" }]);
  const removePort = (index: number) => setPorts(ports.filter((_, i) => i !== index));
  const updatePort = (index: number, field: keyof PortEntry, value: string) =>
    setPorts(ports.map((p, i) => (i === index ? { ...p, [field]: value } : p)));

  const validPorts = ports.filter((p) => p.port !== "");

  const terraformScript = `# Trigger.dev Private Networking - Terraform Configuration
# Creates an NLB and VPC Endpoint Service for your resource

variable "vpc_id" {
  description = "Your VPC ID"
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs in your VPC"
  type        = list(string)
}

variable "target_ip" {
  description = "IP address of the target resource"
  type        = string${hostname ? `\n  default     = "${hostname}"` : ""}
}

# Network Load Balancer
resource "aws_lb" "trigger_privatelink" {
  name               = "trigger-privatelink"
  internal           = true
  load_balancer_type = "network"
  subnets            = var.subnet_ids
}
${validPorts
  .map(
    (p, i) => `
resource "aws_lb_target_group" "port_${p.port}" {
  name        = "trigger-pl-${p.port}"
  port        = ${p.port}
  protocol    = "${p.protocol}"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    protocol = "TCP"
    port     = ${p.port}
  }
}

resource "aws_lb_target_group_attachment" "port_${p.port}" {
  target_group_arn = aws_lb_target_group.port_${p.port}.arn
  target_id        = var.target_ip
  port             = ${p.port}
}

resource "aws_lb_listener" "port_${p.port}" {
  load_balancer_arn = aws_lb.trigger_privatelink.arn
  port              = ${p.port}
  protocol          = "${p.protocol}"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.port_${p.port}.arn
  }
}`
  )
  .join("\n")}

# VPC Endpoint Service
resource "aws_vpc_endpoint_service" "trigger_privatelink" {
  acceptance_required        = false
  network_load_balancer_arns = [aws_lb.trigger_privatelink.arn]
  supported_regions          = ["us-east-1", "eu-central-1"]

  allowed_principals = [
${awsAccountIds.map((id) => `    "arn:aws:iam::${id}:root",`).join("\n")}
  ]
}

output "endpoint_service_name" {
  description = "Paste this into the Trigger.dev dashboard"
  value       = aws_vpc_endpoint_service.trigger_privatelink.service_name
}
`;

  return (
    <div className="space-y-4">
      <InputGroup>
        <Label>Resource hostname or IP</Label>
        <Input
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          placeholder="my-database.abc123.us-east-1.rds.amazonaws.com"
          fullWidth
        />
      </InputGroup>

      <div>
        <Label>Ports</Label>
        <div className="mt-1 space-y-2">
          {ports.map((entry, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={65535}
                value={entry.port}
                onChange={(e) => updatePort(index, "port", e.target.value)}
                placeholder="Port"
                className="w-24"
              />
              <select
                value={entry.protocol}
                onChange={(e) => updatePort(index, "protocol", e.target.value)}
                className="rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright"
              >
                <option value="TCP">TCP</option>
                <option value="UDP">UDP</option>
              </select>
              {ports.length > 1 && (
                <button
                  type="button"
                  onClick={() => removePort(index)}
                  className="text-text-dimmed transition hover:text-rose-400"
                  title="Remove port"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={addPort}
            className="text-xs text-indigo-400 transition hover:text-indigo-300"
          >
            + Add port
          </button>
        </div>
      </div>

      <InputGroup>
        <Label>Resource AWS Region</Label>
        <Select
          variant="tertiary/medium"
          value={region}
          setValue={(v) => setRegion(v)}
          items={AWS_REGIONS}
          filter={(item, search) => {
            const s = search.toLowerCase();
            return item.value.toLowerCase().includes(s) || item.label.toLowerCase().includes(s);
          }}
          text={(value) => {
            const r = AWS_REGIONS.find((r) => r.value === value);
            return r ? `${r.value} — ${r.label}` : value;
          }}
          placeholder="Select a region"
        >
          {(items) =>
            items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <span className="text-text-bright">{item.value}</span>
                <span className="ml-2 text-text-dimmed">{item.label}</span>
              </SelectItem>
            ))
          }
        </Select>
      </InputGroup>

      <div className="rounded-md border border-charcoal-700 bg-charcoal-900">
        <div className="flex items-center justify-between border-b border-charcoal-700 px-3 py-2">
          <span className="text-xs font-medium text-text-dimmed">main.tf</span>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(terraformScript)}
            className="text-xs text-text-dimmed transition hover:text-text-bright"
          >
            Copy
          </button>
        </div>
        <pre className="max-h-64 overflow-auto p-3 text-xs text-text-dimmed">
          <code>{terraformScript}</code>
        </pre>
      </div>
    </div>
  );
}

function AIPromptWizard({ awsAccountIds }: { awsAccountIds: string[] }) {
  const [hostname, setHostname] = useState("");
  const [ports, setPorts] = useState<PortEntry[]>([{ port: "5432", protocol: "TCP" }]);
  const [region, setRegion] = useState("us-east-1");

  const addPort = () => setPorts([...ports, { port: "", protocol: "TCP" }]);
  const removePort = (index: number) => setPorts(ports.filter((_, i) => i !== index));
  const updatePort = (index: number, field: keyof PortEntry, value: string) =>
    setPorts(ports.map((p, i) => (i === index ? { ...p, [field]: value } : p)));

  const validPorts = ports.filter((p) => p.port !== "");
  const regionLabel = AWS_REGIONS.find((r) => r.value === region)?.label ?? region;

  const portsDescription = validPorts.length > 0
    ? validPorts.map((p) => `${p.port} (${p.protocol})`).join(", ")
    : "5432 (TCP)";

  const prompt = `I need to set up AWS PrivateLink so that Trigger.dev can connect to my resource. Please create the following in my AWS account in the ${region} (${regionLabel}) region:

1. A Network Load Balancer (NLB):
   - Name: trigger-privatelink
   - Internal: yes
   - Type: network
   - Place it in my private subnets

2. For each of the following ports, create a target group, target group attachment, and listener:
${validPorts.length > 0 ? validPorts.map((p) => `   - Port ${p.port} (${p.protocol})`).join("\n") : "   - Port 5432 (TCP)"}

   Each target group should:
   - Target type: ip
   - Target IP: ${hostname || "<my-resource-ip>"}
   - Have a TCP health check on the same port

3. A VPC Endpoint Service:
   - Acceptance required: no
   - Attach the NLB created above
   - Supported regions: us-east-1, eu-central-1
   - Allowed principals:
${awsAccountIds.map((id) => `     - arn:aws:iam::${id}:root`).join("\n") || "     - <Trigger.dev AWS account ARN>"}

After creating everything, give me the VPC Endpoint Service name (it looks like com.amazonaws.vpce.<region>.vpce-svc-*) so I can paste it into the Trigger.dev dashboard.`;

  return (
    <div className="space-y-4">
      <InputGroup>
        <Label>Resource hostname or IP</Label>
        <Input
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          placeholder="my-database.abc123.us-east-1.rds.amazonaws.com"
          fullWidth
        />
      </InputGroup>

      <div>
        <Label>Ports</Label>
        <div className="mt-1 space-y-2">
          {ports.map((entry, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={65535}
                value={entry.port}
                onChange={(e) => updatePort(index, "port", e.target.value)}
                placeholder="Port"
                className="w-24"
              />
              <select
                value={entry.protocol}
                onChange={(e) => updatePort(index, "protocol", e.target.value)}
                className="rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright"
              >
                <option value="TCP">TCP</option>
                <option value="UDP">UDP</option>
              </select>
              {ports.length > 1 && (
                <button
                  type="button"
                  onClick={() => removePort(index)}
                  className="text-text-dimmed transition hover:text-rose-400"
                  title="Remove port"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={addPort}
            className="text-xs text-indigo-400 transition hover:text-indigo-300"
          >
            + Add port
          </button>
        </div>
      </div>

      <InputGroup>
        <Label>Resource AWS Region</Label>
        <Select
          variant="tertiary/medium"
          value={region}
          setValue={(v) => setRegion(v)}
          items={AWS_REGIONS}
          filter={(item, search) => {
            const s = search.toLowerCase();
            return item.value.toLowerCase().includes(s) || item.label.toLowerCase().includes(s);
          }}
          text={(value) => {
            const r = AWS_REGIONS.find((r) => r.value === value);
            return r ? `${r.value} — ${r.label}` : value;
          }}
          placeholder="Select a region"
        >
          {(items) =>
            items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <span className="text-text-bright">{item.value}</span>
                <span className="ml-2 text-text-dimmed">{item.label}</span>
              </SelectItem>
            ))
          }
        </Select>
      </InputGroup>

      <div className="rounded-md border border-charcoal-700 bg-charcoal-900">
        <div className="flex items-center justify-between border-b border-charcoal-700 px-3 py-2">
          <span className="text-xs font-medium text-text-dimmed">AI Prompt</span>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(prompt)}
            className="text-xs text-text-dimmed transition hover:text-text-bright"
          >
            Copy
          </button>
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-3 text-xs text-text-dimmed">
          {prompt}
        </pre>
      </div>
    </div>
  );
}

export default function Page() {
  const { availableRegions, activeRegions, awsAccountIds } = useTypedLoaderData<typeof loader>();
  const { organizationSlug } = useParams();
  const lastSubmission = useActionData();
  const [setupMethod, setSetupMethod] = useState<SetupMethod | null>(null);

  const defaultRegion = "us-east-1";

  const [form, { name, endpointServiceName, targetRegion }] = useForm({
    id: "create-private-connection",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Add Private Connection" backButton={{ to: v3PrivateConnectionsPath({ slug: organizationSlug! }), text: "Private Connections" }} />
      </NavBar>
      <PageBody scrollable={true}>
        <MainHorizontallyCenteredContainer className="max-w-3xl">
          <div>
            <div className="mb-4 border-b border-grid-dimmed pb-3">
              <Header2 spacing>Add Private Connection</Header2>
              <Paragraph variant="small">
                Connect your AWS resources to Trigger.dev task pods via AWS PrivateLink. You'll need
                to create a VPC Endpoint Service on your AWS account first.
              </Paragraph>
            </div>

            {/* Setup method cards */}
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <button
                type="button"
                onClick={() => setSetupMethod("manual")}
                className={`rounded-lg border p-4 text-left transition ${
                  setupMethod === "manual"
                    ? "border-indigo-500 bg-indigo-500/10"
                    : "border-grid-dimmed hover:border-charcoal-600"
                }`}
              >
                <PencilSquareIcon className="mb-2 h-5 w-5 text-indigo-400" />
                <div className="text-sm font-medium text-text-bright">I have my details</div>
                <div className="mt-1 text-xs text-text-dimmed">
                  Already have your VPC Endpoint Service name
                </div>
              </button>
              <button
                type="button"
                onClick={() => setSetupMethod("ai")}
                className={`rounded-lg border p-4 text-left transition ${
                  setupMethod === "ai"
                    ? "border-indigo-500 bg-indigo-500/10"
                    : "border-grid-dimmed hover:border-charcoal-600"
                }`}
              >
                <SparklesIcon className="mb-2 h-5 w-5 text-purple-400" />
                <div className="text-sm font-medium text-text-bright">Set up with AI</div>
                <div className="mt-1 text-xs text-text-dimmed">
                  Generate a prompt for your AI assistant
                </div>
              </button>
              <button
                type="button"
                onClick={() => setSetupMethod("terraform")}
                className={`rounded-lg border p-4 text-left transition ${
                  setupMethod === "terraform"
                    ? "border-indigo-500 bg-indigo-500/10"
                    : "border-grid-dimmed hover:border-charcoal-600"
                }`}
              >
                <CommandLineIcon className="mb-2 h-5 w-5 text-emerald-400" />
                <div className="text-sm font-medium text-text-bright">Set up with Terraform</div>
                <div className="mt-1 text-xs text-text-dimmed">
                  Generate a customized Terraform script
                </div>
              </button>
              <button
                type="button"
                onClick={() => setSetupMethod("docs")}
                className={`rounded-lg border p-4 text-left transition ${
                  setupMethod === "docs"
                    ? "border-indigo-500 bg-indigo-500/10"
                    : "border-grid-dimmed hover:border-charcoal-600"
                }`}
              >
                <DocumentTextIcon className="mb-2 h-5 w-5 text-amber-400" />
                <div className="text-sm font-medium text-text-bright">Step-by-step guide</div>
                <div className="mt-1 text-xs text-text-dimmed">
                  Visual instructions for the AWS Console
                </div>
              </button>
            </div>

            {/* AI prompt wizard */}
            {setupMethod === "ai" && (
              <div className="mb-6 rounded-lg border border-grid-dimmed p-4">
                <Header3 spacing>AI-Assisted Setup</Header3>
                <Paragraph variant="small" className="mb-4">
                  Fill in your resource details below and we'll generate a prompt you can paste into
                  Claude, ChatGPT, or any AI assistant with AWS access. After it creates the
                  resources, paste the VPC Endpoint Service name below.
                </Paragraph>
                <AIPromptWizard awsAccountIds={awsAccountIds} />
              </div>
            )}

            {/* Terraform wizard (expandable) */}
            {setupMethod === "terraform" && (
              <div className="mb-6 rounded-lg border border-grid-dimmed p-4">
                <Header3 spacing>Terraform Configuration</Header3>
                <Paragraph variant="small" className="mb-4">
                  Fill in your resource details below and we'll generate a Terraform script. Run{" "}
                  <code className="rounded bg-charcoal-800 px-1 py-0.5 text-xs">
                    terraform apply
                  </code>{" "}
                  to create the VPC Endpoint Service, then paste the output service name below.
                </Paragraph>
                <TerraformWizard awsAccountIds={awsAccountIds} />
              </div>
            )}

            {/* Docs iframe */}
            {setupMethod === "docs" && (
              <div className="mb-6 rounded-lg border border-grid-dimmed p-4">
                <Header3 spacing>Setup Guide</Header3>
                {awsAccountIds.length > 0 && (
                  <>
                    <Paragraph variant="small" className="mb-3">
                      When adding allowed principals to your VPC Endpoint Service, use the following
                      AWS account ID(s):
                    </Paragraph>
                    <div className="mb-4 rounded-md border border-charcoal-700 bg-charcoal-900 p-3">
                      {awsAccountIds.map((id) => (
                        <code key={id} className="text-sm text-emerald-400">
                          {id}
                        </code>
                      ))}
                    </div>
                  </>
                )}
                <iframe
                  src="https://trigger.dev/docs/network/private-link-setup-guide"
                  title="Private Link Setup Guide"
                  className="h-[600px] w-full rounded-md border border-charcoal-700"
                />
              </div>
            )}

            {/* AWS account IDs reference */}
            {setupMethod === "manual" && (
              <div className="mb-6 rounded-lg border border-grid-dimmed p-4">
                <Paragraph variant="small" className="mb-2">
                  Add the following AWS account ID(s) to your VPC Endpoint Service's allowed
                  principals:
                </Paragraph>
                <div className="rounded-md border border-charcoal-700 bg-charcoal-900 p-3">
                  {awsAccountIds.map((id) => (
                    <code key={id} className="text-sm text-emerald-400">
                      {id}
                    </code>
                  ))}
                </div>
              </div>
            )}

            {/* Connection form (always visible) */}
            <div className="rounded-lg border border-grid-dimmed p-4">
              <Header3 spacing>Connection Details</Header3>
              <Form method="post" {...form.props}>
                <Fieldset>
                  <InputGroup fullWidth>
                    <Label htmlFor={name.id} required>
                      Friendly name
                    </Label>
                    <Input
                      {...conform.input(name, { type: "text" })}
                      placeholder="e.g., Production Database, Redis Cache"
                      fullWidth
                    />
                    <FormError id={name.errorId}>{name.error}</FormError>
                  </InputGroup>
                  <InputGroup fullWidth>
                    <Label htmlFor={endpointServiceName.id} required>
                      VPC Endpoint Service name
                    </Label>
                    <Input
                      {...conform.input(endpointServiceName, { type: "text" })}
                      placeholder="com.amazonaws.vpce.us-east-1.vpce-svc-0123456789abcdef0"
                      fullWidth
                    />
                    <FormError id={endpointServiceName.errorId}>
                      {endpointServiceName.error}
                    </FormError>
                  </InputGroup>
                  <InputGroup fullWidth>
                    <Label htmlFor={targetRegion.id} required>
                      Target region
                    </Label>
                    <select
                      {...conform.input(targetRegion)}
                      defaultValue={defaultRegion}
                      className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright"
                    >
                      {availableRegions.map((region: string) => (
                        <option key={region} value={region}>
                          {region}
                        </option>
                      ))}
                    </select>
                    <FormError id={targetRegion.errorId}>{targetRegion.error}</FormError>
                    {activeRegions.length > 0 && (
                      <Paragraph variant="extra-small" className="text-text-dimmed">
                        Your tasks have recently run in: {activeRegions.join(", ")}
                      </Paragraph>
                    )}
                  </InputGroup>
                  <FormButtons
                    cancelButton={
                      <LinkButton variant="tertiary/small" to="..">
                        Cancel
                      </LinkButton>
                    }
                    confirmButton={
                      <Button type="submit" variant="primary/small">
                        Create Connection
                      </Button>
                    }
                  />
                </Fieldset>
              </Form>
            </div>
          </div>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}

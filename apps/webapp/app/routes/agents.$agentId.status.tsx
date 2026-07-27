import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { requireUser } from "~/services/auth.server";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { agentId } = params;

  if (!agentId) {
    throw new Response("Not found", { status: 404 });
  }

  // Get agent config
  const agentConfig = await prisma.agentConfig.findUnique({
    where: { id: agentId },
    include: {
      executions: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
      healthChecks: {
        orderBy: { createdAt: "desc" },
        take: 5,
      },
    },
  });

  if (!agentConfig || agentConfig.userId !== user.id) {
    throw new Response("Not found", { status: 404 });
  }

  return typedjson({
    agentConfig,
  });
};

function getStatusColor(status: string) {
  switch (status) {
    case "healthy":
      return "text-green-600 bg-green-50";
    case "unhealthy":
      return "text-red-600 bg-red-50";
    case "provisioning":
      return "text-yellow-600 bg-yellow-50";
    default:
      return "text-gray-600 bg-gray-50";
  }
}

export default function AgentStatus() {
  const { agentConfig } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <PageBody>
        <Header1>{agentConfig.name}</Header1>

        <div className="grid grid-cols-2 gap-6 mt-8">
          {/* Basic Info */}
          <div className="bg-gray-50 rounded-lg p-6">
            <Header2>Configuration</Header2>
            <div className="space-y-3 mt-4 text-sm">
              <div>
                <span className="font-medium">Status:</span>
                <span className={`ml-2 px-2 py-1 rounded ${getStatusColor(agentConfig.status)}`}>
                  {agentConfig.status}
                </span>
              </div>
              <div>
                <span className="font-medium">Model:</span>
                <span className="ml-2">{agentConfig.model}</span>
              </div>
              <div>
                <span className="font-medium">Platform:</span>
                <span className="ml-2">{agentConfig.messagingPlatform}</span>
              </div>
              <div>
                <span className="font-medium">Container:</span>
                <span className="ml-2">
                  {agentConfig.containerName && agentConfig.containerPort
                    ? `${agentConfig.containerName}:${agentConfig.containerPort}`
                    : "Not provisioned"}
                </span>
              </div>
              <div>
                <span className="font-medium">Created:</span>
                <span className="ml-2">{new Date(agentConfig.createdAt).toLocaleString()}</span>
              </div>
            </div>
          </div>

          {/* Tools */}
          <div className="bg-gray-50 rounded-lg p-6">
            <Header2>Tools</Header2>
            <div className="mt-4">
              {Array.isArray(agentConfig.tools) && agentConfig.tools.length > 0 ? (
                <ul className="space-y-2">
                  {(agentConfig.tools as string[]).map((tool) => (
                    <li key={tool} className="text-sm">
                      ✓ {tool}
                    </li>
                  ))}
                </ul>
              ) : (
                <Paragraph>No tools configured</Paragraph>
              )}
            </div>
          </div>
        </div>

        {/* Recent Executions */}
        {agentConfig.executions.length > 0 && (
          <div className="mt-8">
            <Header2>Recent Executions</Header2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Message</TableHeaderCell>
                  <TableHeaderCell>Response</TableHeaderCell>
                  <TableHeaderCell>Time (ms)</TableHeaderCell>
                  <TableHeaderCell>Date</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agentConfig.executions.map((exec) => (
                  <TableRow key={exec.id}>
                    <TableCell className="max-w-xs truncate">{exec.message}</TableCell>
                    <TableCell className="max-w-xs truncate">{exec.response}</TableCell>
                    <TableCell>{exec.executionTimeMs}ms</TableCell>
                    <TableCell>{new Date(exec.createdAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Health History */}
        {agentConfig.healthChecks.length > 0 && (
          <div className="mt-8">
            <Header2>Health Checks</Header2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Response Time</TableHeaderCell>
                  <TableHeaderCell>Date</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agentConfig.healthChecks.map((check) => (
                  <TableRow key={check.id}>
                    <TableCell>
                      <span
                        className={`px-2 py-1 rounded text-sm ${
                          check.isHealthy
                            ? "bg-green-50 text-green-600"
                            : "bg-red-50 text-red-600"
                        }`}
                      >
                        {check.isHealthy ? "✓ Healthy" : "✗ Unhealthy"}
                      </span>
                    </TableCell>
                    <TableCell>{check.responseTimeMs}ms</TableCell>
                    <TableCell>{new Date(check.createdAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PageBody>
    </PageContainer>
  );
}

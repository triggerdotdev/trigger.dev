import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { spawn } from "child_process";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";

/**
 * POST /api/agents/provision
 * Provisions an OpenClaw container for a given agent config
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const { agentId } = await request.json() as { agentId: string };

  if (!agentId) {
    return json({ error: "agentId is required" }, { status: 400 });
  }

  try {
    // Get agent config
    const agentConfig = await prisma.agentConfig.findUnique({
      where: { id: agentId },
    });

    if (!agentConfig) {
      return json({ error: "Agent not found" }, { status: 404 });
    }

    // Find the next available port (starting at 8001)
    const lastAgent = await prisma.agentConfig.findFirst({
      where: {
        containerPort: { not: null },
      },
      orderBy: { containerPort: "desc" },
    });

    const nextPort = (lastAgent?.containerPort || 8000) + 1;

    // Generate container name
    const containerName = `openclaw-${agentConfig.userId.slice(0, 8)}-${agentConfig.id.slice(0, 8)}`;

    logger.info("Provisioning OpenClaw container", {
      agentId,
      containerName,
      port: nextPort,
    });

    // TODO: Implement actual Docker provisioning
    // For now, just update the database with port info
    // Production would SSH to VPS and run: docker run -d --name $containerName -p $nextPort:8000 openclaw:latest

    const updatedAgent = await prisma.agentConfig.update({
      where: { id: agentId },
      data: {
        containerName,
        containerPort: nextPort,
        status: "provisioning",
      },
    });

    // Log provisioning start (not health check yet since container doesn't exist)
    await prisma.agentHealthCheck.create({
      data: {
        agentId,
        isHealthy: false,
        errorMessage: "Container provisioning started - awaiting actual deployment",
      },
    });

    logger.info("Agent provisioned successfully", {
      agentId,
      containerName,
      port: nextPort,
    });

    return json({
      success: true,
      agentId,
      containerName,
      containerPort: nextPort,
    });
  } catch (error) {
    logger.error("Failed to provision agent", { error, agentId });
    return json(
      { error: error instanceof Error ? error.message : "Provisioning failed" },
      { status: 500 }
    );
  }
};

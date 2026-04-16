import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";

export class AgentHealthCheckService {
  private static VPS_IP = "178.128.150.129";

  public async call() {
    const agents = await prisma.agentConfig.findMany({
      where: {
        status: { in: ["healthy", "provisioning", "unhealthy"] },
        containerPort: { not: null },
      },
    });

    logger.debug(`Running health checks for ${agents.length} agents`);

    for (const agent of agents) {
      await this.checkAgent(agent);
    }
  }

  private async checkAgent(agent: any) {
    const url = `http://${AgentHealthCheckService.VPS_IP}:${agent.containerPort}/api/health`;
    const start = Date.now();

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const duration = Date.now() - start;

      if (response.ok) {
        await this.updateStatus(agent.id, true, duration);
      } else {
        await this.updateStatus(agent.id, false, duration, `Health check returned ${response.status}`);
      }
    } catch (error) {
      const duration = Date.now() - start;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      await this.updateStatus(agent.id, false, duration, errorMessage);
    }
  }

  private async updateStatus(agentId: string, isHealthy: boolean, duration: number, error?: string) {
    const status = isHealthy ? "healthy" : "unhealthy";

    await prisma.agentConfig.update({
      where: { id: agentId },
      data: { status },
    });

    await prisma.agentHealthCheck.create({
      data: {
        agentId,
        isHealthy,
        responseTimeMs: duration,
        errorMessage: error,
      },
    });

    if (!isHealthy) {
      logger.warn(`Agent ${agentId} is unhealthy`, { error, duration });
    }
  }
}

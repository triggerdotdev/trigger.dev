import { spawn } from "child_process";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";

export class AgentProvisioningService {
  private static VPS_IP = "178.128.150.129";
  private static SSH_USER = "root";

  static async provision(agentId: string) {
    const agent = await prisma.agentConfig.findUnique({
      where: { id: agentId },
    });

    if (!agent || !agent.containerName || !agent.containerPort) {
      throw new Error("Invalid agent config for provisioning");
    }

    const { containerName, containerPort } = agent;

    logger.info("Starting Docker provisioning on VPS", {
      agentId,
      containerName,
      port: containerPort,
    });

    // 1. Stop and remove existing container if it exists
    await this.runSshCommand(`docker rm -f ${containerName} || true`);

    // 2. Run new container
    // Note: This assumes the 'openclaw' image is available on the VPS
    const dockerRunCmd = `docker run -d --name ${containerName} -p ${containerPort}:8000 --restart always openclaw:latest`;
    
    try {
      await this.runSshCommand(dockerRunCmd);
      
      // 3. Update status to healthy if provisioning command succeeded
      await prisma.agentConfig.update({
        where: { id: agentId },
        data: { status: "healthy" },
      });

      logger.info("Agent provisioning completed successfully", { agentId });
    } catch (error) {
       logger.error("Docker run failed", { agentId, error });
       
       await prisma.agentConfig.update({
        where: { id: agentId },
        data: { status: "unhealthy" },
      });

      await prisma.agentHealthCheck.create({
        data: {
          agentId,
          isHealthy: false,
          errorMessage: error instanceof Error ? error.message : "Docker run failed",
        },
      });

      throw error;
    }
  }

  private static runSshCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Assumes SSH key is configured for the root user on the host running the webapp
      const ssh = spawn("ssh", [
        "-o", "StrictHostKeyChecking=no",
        `${this.SSH_USER}@${this.VPS_IP}`,
        command
      ]);

      let stdout = "";
      let stderr = "";

      ssh.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      ssh.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      ssh.on("close", (code: number | null) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`SSH command failed with code ${code}: ${stderr.trim()}`));
        }
      });

      ssh.on("error", (err: Error) => {
        reject(err);
      });
    });
  }
}

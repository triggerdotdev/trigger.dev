import { logger, skills, task } from "@trigger.dev/sdk";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { access, constants } from "node:fs/promises";

const greeterSkill = skills.define({
  id: "greeter",
  path: "./skills/greeter",
});

const execAsync = promisify(exec);

export const testSkillTask = task({
  id: "test-skill",
  run: async (payload: { name?: string } = {}) => {
    const resolved = await greeterSkill.local();

    logger.info("Resolved skill", {
      id: resolved.id,
      version: resolved.version,
      path: resolved.path,
      frontmatterName: resolved.frontmatter.name,
      frontmatterDescription: resolved.frontmatter.description,
      bodyChars: resolved.body.length,
    });

    const scriptPath = join(resolved.path, "scripts", "hello.sh");
    await access(scriptPath, constants.X_OK);

    const { stdout } = await execAsync(`bash ${scriptPath} ${payload.name ?? "world"}`);
    const output = stdout.trim();
    logger.info("Script output", { output });

    return {
      skillId: resolved.id,
      skillPath: resolved.path,
      frontmatterName: resolved.frontmatter.name,
      scriptOutput: output,
    };
  },
});

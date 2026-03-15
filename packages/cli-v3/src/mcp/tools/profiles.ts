import { z } from "zod";
import { toolsMetadata } from "../config.js";
import { respondWithError, toolHandler } from "../utils.js";
import {
  listAuthConfigProfiles,
  readAuthConfigProfile,
  readAuthConfigCurrentProfileName,
} from "../../utilities/configFiles.js";

export const whoamiTool = {
  name: toolsMetadata.whoami.name,
  title: toolsMetadata.whoami.title,
  description: toolsMetadata.whoami.description,
  inputSchema: {},
  handler: toolHandler({}, async (_input, { ctx }) => {
    ctx.logger?.log("calling whoami");

    try {
      const auth = await ctx.getAuth();

      const content = [
        "## Current Session",
        "",
        `**Profile:** ${auth.profile}`,
        `**Email:** ${auth.email}`,
        `**User ID:** ${auth.userId}`,
        `**API URL:** ${auth.auth.apiUrl}`,
        `**Dashboard:** ${auth.dashboardUrl}`,
      ];

      return {
        content: [{ type: "text" as const, text: content.join("\n") }],
      };
    } catch (error) {
      return respondWithError("Not authenticated. Use an authenticated tool to trigger login.");
    }
  }),
};

export const listProfilesTool = {
  name: toolsMetadata.list_profiles.name,
  title: toolsMetadata.list_profiles.title,
  description: toolsMetadata.list_profiles.description,
  inputSchema: {},
  handler: toolHandler({}, async (_input, { ctx }) => {
    ctx.logger?.log("calling list_profiles");

    const profiles = listAuthConfigProfiles();
    const currentProfile = ctx.options.profile ?? readAuthConfigCurrentProfileName();

    if (profiles.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No profiles configured. Use an authenticated tool to trigger login and create a profile.",
          },
        ],
      };
    }

    const content = ["## CLI Profiles", ""];

    for (const name of profiles) {
      const config = readAuthConfigProfile(name);
      const isCurrent = name === currentProfile;
      const marker = isCurrent ? " (active)" : "";
      const apiUrl = config?.apiUrl ?? "https://cloud.trigger.dev";

      content.push(`- **${name}**${marker} — ${apiUrl}`);
    }

    content.push("");
    content.push(
      "Use `switch_profile` to change the active profile for this session."
    );

    return {
      content: [{ type: "text" as const, text: content.join("\n") }],
    };
  }),
};

const SwitchProfileInput = {
  profile: z
    .string()
    .describe("The profile name to switch to. Use list_profiles to see available profiles."),
};

export const switchProfileTool = {
  name: toolsMetadata.switch_profile.name,
  title: toolsMetadata.switch_profile.title,
  description: toolsMetadata.switch_profile.description,
  inputSchema: SwitchProfileInput,
  handler: toolHandler(SwitchProfileInput, async (input, { ctx }) => {
    ctx.logger?.log("calling switch_profile", { input });

    const profiles = listAuthConfigProfiles();

    if (!profiles.includes(input.profile)) {
      const available = profiles.length > 0 ? profiles.join(", ") : "(none)";
      return respondWithError(
        `Profile "${input.profile}" not found. Available profiles: ${available}`
      );
    }

    const previousProfile = ctx.options.profile ?? readAuthConfigCurrentProfileName();
    const projectDir = await ctx.getCwd();
    ctx.switchProfile(input.profile, projectDir);

    // Verify the new profile works by fetching auth
    try {
      const auth = await ctx.getAuth();

      const persisted = projectDir ? " (saved to project)" : " (session only)";

      const content = [
        `Switched from **${previousProfile}** to **${input.profile}**${persisted}`,
        "",
        `**Email:** ${auth.email}`,
        `**API URL:** ${auth.auth.apiUrl}`,
      ];

      return {
        content: [{ type: "text" as const, text: content.join("\n") }],
      };
    } catch (error) {
      // Revert on failure
      ctx.switchProfile(previousProfile, projectDir);
      return respondWithError(
        `Failed to authenticate with profile "${input.profile}". Reverted to "${previousProfile}".`
      );
    }
  }),
};

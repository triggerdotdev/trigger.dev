import type { GitHubAppAuthorization } from ".prisma/client";
import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import {
  AccountSchema,
  createOrgRepository,
  createUserRepository,
} from "../github/githubApp.server";

const FormSchema = z.object({
  name: z.string().min(3).max(100),
  templateId: z.string(),
  private: z.literal("on").optional(),
  appAuthorizationId: z.string(),
});

export class AddTemplateService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public validate(payload: unknown) {
    return FormSchema.safeParse(payload);
  }

  public async call({
    userId,
    organizationSlug,
    data,
  }: {
    userId: string;
    organizationSlug: string;
    data: z.infer<typeof FormSchema>;
  }) {
    const appAuthorization =
      await this.#prismaClient.gitHubAppAuthorization.findUnique({
        where: {
          id: data.appAuthorizationId,
        },
      });

    if (!appAuthorization) {
      return {
        type: "error" as const,
        message: "App authorization not found",
      };
    }

    const template = await this.#prismaClient.template.findUnique({
      where: {
        id: data.templateId,
      },
    });

    if (!template) {
      return {
        type: "error" as const,
        message: "Template not found",
      };
    }

    const account = AccountSchema.safeParse(appAuthorization.account);

    if (!account.success) {
      return {
        type: "error" as const,
        message: "Account not found",
      };
    }

    const createdGithubRepo = await this.#createGitHubRepository(
      appAuthorization,
      data
    );

    if (createdGithubRepo.status === "error") {
      return {
        type: "error" as const,
        message: createdGithubRepo.message,
      };
    }

    const githubRepository = createdGithubRepo.data;

    const organizationTemplate =
      await this.#prismaClient.organizationTemplate.create({
        data: {
          name: data.name,
          status: "CREATED",
          repositoryId: githubRepository.id,
          repositoryUrl: githubRepository.html_url,
          repositoryData: githubRepository,
          template: {
            connect: {
              id: data.templateId,
            },
          },
          private: data.private === "on",
          organization: {
            connect: {
              slug: organizationSlug,
            },
          },
          authorization: {
            connect: {
              id: data.appAuthorizationId,
            },
          },
        },
      });

    return {
      type: "success" as const,
      template: organizationTemplate,
    };
  }

  async #createGitHubRepository(
    authorization: GitHubAppAuthorization,
    data: z.infer<typeof FormSchema>
  ) {
    if (authorization.accountType === "USER") {
      return createUserRepository(
        {
          name: data.name,
          private: data.private === "on",
          auto_init: true,
        },
        {
          token: authorization.token,
          refreshToken: authorization.refreshToken,
        }
      );
    } else {
      return createOrgRepository(
        {
          org: authorization.accountName,
          name: data.name,
          private: data.private === "on",
          auto_init: true,
        },
        {
          token: authorization.token,
          refreshToken: authorization.refreshToken,
        }
      );
    }
  }
}

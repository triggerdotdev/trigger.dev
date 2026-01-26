import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { uiComponent } from "@team-plain/typescript-sdk";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

// Schema for the request body from Plain
const PlainCustomerCardRequestSchema = z.object({
  cardKeys: z.array(z.string()),
  customer: z.object({
    id: z.string(),
    email: z.string().optional(),
    externalId: z.string().optional(),
  }),
  thread: z
    .object({
      id: z.string(),
    })
    .optional(),
});

// Authenticate the request from Plain
function authenticatePlainRequest(request: Request): boolean {
  const authHeader = request.headers.get("PLAIN_AUTH");
  const expectedSecret = env.PLAIN_CUSTOMER_CARDS_SECRET;
  if (!expectedSecret) {
    logger.warn("PLAIN_CUSTOMER_CARDS_SECRET not configured");
    return false;
  }

  if (!authHeader) {
    return false;
  }

  // Support both "Bearer <token>" and plain token formats
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  return token === expectedSecret;
}

export async function action({ request }: ActionFunctionArgs) {
  // Only accept POST requests
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // Authenticate the request
  if (!authenticatePlainRequest(request)) {
    logger.warn("Unauthorized Plain customer card request", {
      headers: Object.fromEntries(request.headers.entries()),
    });
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Parse and validate the request body
    const body = await request.json();
    const parsed = PlainCustomerCardRequestSchema.safeParse(body);

    if (!parsed.success) {
      logger.warn("Invalid Plain customer card request", {
        errors: parsed.error.errors,
        body,
      });
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const { customer, cardKeys } = parsed.data;

    // Look up the user by externalId (which is User.id)
    let user = null;
    if (customer.externalId) {
      user = await prisma.user.findUnique({
        where: { id: customer.externalId },
        include: {
          orgMemberships: {
            include: {
              organization: {
                include: {
                  projects: {
                    where: { deletedAt: null },
                    take: 10, // Limit to recent projects
                    orderBy: { createdAt: "desc" },
                  },
                },
              },
            },
          },
        },
      });
    } else if (customer.email) {
      // Fallback to email lookup if externalId is not provided
      user = await prisma.user.findUnique({
        where: { email: customer.email },
        include: {
          orgMemberships: {
            include: {
              organization: {
                include: {
                  projects: {
                    where: { deletedAt: null },
                    take: 10,
                    orderBy: { createdAt: "desc" },
                  },
                },
              },
            },
          },
        },
      });
    }

    // If user not found, return empty cards
    if (!user) {
      logger.info("User not found for Plain customer card request", {
        customerId: customer.id,
        externalId: customer.externalId,
        email: customer.email,
      });
      return json({ cards: [] });
    }

    // Build cards based on requested cardKeys
    const cards = [];

    for (const cardKey of cardKeys) {
      switch (cardKey) {
        case "account-details": {
          // Build the impersonate URL
          const impersonateUrl = `${env.APP_ORIGIN || "https://cloud.trigger.dev"}/admin?impersonate=${user.id}`;

          cards.push({
            key: "account-details",
            timeToLiveSeconds: 300, // Cache for 5 minutes
            components: [
              uiComponent.container({
                content: [
                  uiComponent.text({
                    text: "Account Details",
                    size: "L",
                    color: "NORMAL",
                  }),
                  uiComponent.spacer({ size: "M" }),
                  uiComponent.row({
                    mainContent: [
                      uiComponent.text({
                        text: "User ID",
                        size: "S",
                        color: "MUTED",
                      }),
                    ],
                    asideContent: [
                      uiComponent.copyButton({
                        value: user.id,
                        tooltip: "Copy",
                      }),
                    ],
                  }),
                  uiComponent.spacer({ size: "S" }),
                  uiComponent.row({
                    mainContent: [
                      uiComponent.text({
                        text: "Email",
                        size: "S",
                        color: "MUTED",
                      }),
                    ],
                    asideContent: [
                      uiComponent.text({
                        text: user.email,
                        size: "S",
                        color: "NORMAL",
                      }),
                    ],
                  }),
                  uiComponent.spacer({ size: "S" }),
                  uiComponent.row({
                    mainContent: [
                      uiComponent.text({
                        text: "Name",
                        size: "S",
                        color: "MUTED",
                      }),
                    ],
                    asideContent: [
                      uiComponent.text({
                        text: user.name || user.displayName || "N/A",
                        size: "S",
                        color: "NORMAL",
                      }),
                    ],
                  }),
                  uiComponent.spacer({ size: "S" }),
                  uiComponent.row({
                    mainContent: [
                      uiComponent.text({
                        text: "Admin",
                        size: "S",
                        color: "MUTED",
                      }),
                    ],
                    asideContent: [
                      uiComponent.badge({
                        label: user.admin ? "Yes" : "No",
                        color: user.admin ? "BLUE" : "GREY",
                      }),
                    ],
                  }),
                  uiComponent.spacer({ size: "S" }),
                  uiComponent.row({
                    mainContent: [
                      uiComponent.text({
                        text: "Member Since",
                        size: "S",
                        color: "MUTED",
                      }),
                    ],
                    asideContent: [
                      uiComponent.text({
                        text: new Date(user.createdAt).toLocaleDateString(),
                        size: "S",
                        color: "NORMAL",
                      }),
                    ],
                  }),
                  uiComponent.spacer({ size: "M" }),
                  uiComponent.divider({ spacingSize: "M" }),
                  uiComponent.spacer({ size: "M" }),
                  uiComponent.linkButton({
                    label: "Impersonate User",
                    url: impersonateUrl,
                  }),
                ],
              }),
            ],
          });
          break;
        }

        case "organizations": {
          if (user.orgMemberships.length === 0) {
            cards.push({
              key: "organizations",
              timeToLiveSeconds: 300,
              components: [
                uiComponent.container({
                  content: [
                    uiComponent.text({
                      text: "Organizations",
                      size: "L",
                      color: "NORMAL",
                    }),
                    uiComponent.spacer({ size: "M" }),
                    uiComponent.text({
                      text: "No organizations found",
                      size: "S",
                      color: "MUTED",
                    }),
                  ],
                }),
              ],
            });
            break;
          }

          const orgComponents = user.orgMemberships.flatMap(
            (
              membership: (typeof user.orgMemberships)[0],
              index: number
            ) => {
              const org = membership.organization;
              const projectCount = org.projects.length;

              return [
                ...(index > 0 ? [uiComponent.divider({ spacingSize: "M" })] : []),
                uiComponent.text({
                  text: org.title,
                  size: "M",
                  color: "NORMAL",
                }),
                uiComponent.spacer({ size: "XS" }),
                uiComponent.row({
                  mainContent: [
                    uiComponent.badge({
                      label: membership.role,
                      color: membership.role === "ADMIN" ? "BLUE" : "GREY",
                    }),
                  ],
                  asideContent: [
                    uiComponent.text({
                      text: `${projectCount} project${projectCount !== 1 ? "s" : ""}`,
                      size: "S",
                      color: "MUTED",
                    }),
                  ],
                }),
                uiComponent.spacer({ size: "XS" }),
                uiComponent.linkButton({
                  label: "View in Dashboard",
                  url: `https://cloud.trigger.dev/@/orgs/${org.slug}`,
                }),
              ];
            }
          );

          cards.push({
            key: "organizations",
            timeToLiveSeconds: 300,
            components: [
              uiComponent.container({
                content: [
                  uiComponent.text({
                    text: "Organizations",
                    size: "L",
                    color: "NORMAL",
                  }),
                  uiComponent.spacer({ size: "M" }),
                  ...orgComponents,
                ],
              }),
            ],
          });
          break;
        }

        case "projects": {
          const allProjects = user.orgMemberships.flatMap((membership) =>
            membership.organization.projects.map((project) => ({
              ...project,
              orgSlug: membership.organization.slug,
            }))
          );

          if (allProjects.length === 0) {
            cards.push({
              key: "projects",
              timeToLiveSeconds: 300,
            components: [
              uiComponent.container({
                content: [
                  uiComponent.text({
                    text: "Projects",
                      size: "L",
                      color: "NORMAL",
                    }),
                    uiComponent.spacer({ size: "M" }),
                    uiComponent.text({
                      text: "No projects found",
                      size: "S",
                      color: "MUTED",
                    }),
                  ],
                }),
              ],
            });
            break;
          }

          const projectComponents = allProjects.slice(0, 10).flatMap(
            (
              project: typeof allProjects[0] & { orgSlug: string },
              index: number
            ) => {
              return [
                ...(index > 0 ? [uiComponent.divider({ spacingSize: "M" })] : []),
                uiComponent.text({
                  text: project.name,
                  size: "M",
                  color: "NORMAL",
                }),
                uiComponent.spacer({ size: "XS" }),
                uiComponent.row({
                  mainContent: [
                    uiComponent.badge({
                      label: project.version,
                      color: project.version === "V3" ? "GREEN" : "GREY",
                    }),
                  ],
                  asideContent: [
                    uiComponent.linkButton({
                      label: "View",
                      url: `https://cloud.trigger.dev/orgs/${project.orgSlug}/projects/${project.slug}`,
                    }),
                  ],
                }),
              ];
            }
          );

          cards.push({
            key: "projects",
            timeToLiveSeconds: 300,
            components: [
              uiComponent.container({
                content: [
                  uiComponent.text({
                    text: "Projects",
                    size: "L",
                    color: "NORMAL",
                  }),
                  uiComponent.spacer({ size: "M" }),
                  ...projectComponents,
                ],
              }),
            ],
          });
          break;
        }

        default:
          // Unknown card key - skip it
          logger.info("Unknown card key requested", { cardKey });
          break;
      }
    }

    return json({ cards });
  } catch (error) {
    logger.error("Error processing Plain customer card request", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return json({ error: "Internal server error" }, { status: 500 });
  }
}

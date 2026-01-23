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
  const authHeader = request.headers.get("Authorization");
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
                components: [
                  uiComponent.text({
                    text: "Account Details",
                    textSize: "L",
                    textColor: "NORMAL",
                  }),
                  uiComponent.spacer({ spacerSize: "M" }),
                  uiComponent.row({
                    left: uiComponent.text({
                      text: "User ID",
                      textSize: "S",
                      textColor: "MUTED",
                    }),
                    right: uiComponent.copyButton({
                      textToCopy: user.id,
                      buttonLabel: "Copy",
                    }),
                  }),
                  uiComponent.spacer({ spacerSize: "S" }),
                  uiComponent.row({
                    left: uiComponent.text({
                      text: "Email",
                      textSize: "S",
                      textColor: "MUTED",
                    }),
                    right: uiComponent.text({
                      text: user.email,
                      textSize: "S",
                      textColor: "NORMAL",
                    }),
                  }),
                  uiComponent.spacer({ spacerSize: "S" }),
                  uiComponent.row({
                    left: uiComponent.text({
                      text: "Name",
                      textSize: "S",
                      textColor: "MUTED",
                    }),
                    right: uiComponent.text({
                      text: user.name || user.displayName || "N/A",
                      textSize: "S",
                      textColor: "NORMAL",
                    }),
                  }),
                  uiComponent.spacer({ spacerSize: "S" }),
                  uiComponent.row({
                    left: uiComponent.text({
                      text: "Admin",
                      textSize: "S",
                      textColor: "MUTED",
                    }),
                    right: uiComponent.badge({
                      badgeLabel: user.admin ? "Yes" : "No",
                      badgeColor: user.admin ? "BLUE" : "GRAY",
                    }),
                  }),
                  uiComponent.spacer({ spacerSize: "S" }),
                  uiComponent.row({
                    left: uiComponent.text({
                      text: "Member Since",
                      textSize: "S",
                      textColor: "MUTED",
                    }),
                    right: uiComponent.text({
                      text: new Date(user.createdAt).toLocaleDateString(),
                      textSize: "S",
                      textColor: "NORMAL",
                    }),
                  }),
                  uiComponent.spacer({ spacerSize: "M" }),
                  uiComponent.divider(),
                  uiComponent.spacer({ spacerSize: "M" }),
                  uiComponent.linkButton({
                    buttonLabel: "Impersonate User",
                    buttonUrl: impersonateUrl,
                    buttonStyle: "PRIMARY",
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
                  components: [
                    uiComponent.text({
                      text: "Organizations",
                      textSize: "L",
                      textColor: "NORMAL",
                    }),
                    uiComponent.spacer({ spacerSize: "M" }),
                    uiComponent.text({
                      text: "No organizations found",
                      textSize: "S",
                      textColor: "MUTED",
                    }),
                  ],
                }),
              ],
            });
            break;
          }

          const orgComponents = user.orgMemberships.flatMap((membership, index) => {
            const org = membership.organization;
            const projectCount = org.projects.length;

            return [
              ...(index > 0 ? [uiComponent.divider()] : []),
              uiComponent.text({
                text: org.title,
                textSize: "M",
                textColor: "NORMAL",
              }),
              uiComponent.spacer({ spacerSize: "XS" }),
              uiComponent.row({
                left: uiComponent.badge({
                  badgeLabel: membership.role,
                  badgeColor: membership.role === "ADMIN" ? "BLUE" : "GRAY",
                }),
                right: uiComponent.text({
                  text: `${projectCount} project${projectCount !== 1 ? "s" : ""}`,
                  textSize: "S",
                  textColor: "MUTED",
                }),
              }),
              uiComponent.spacer({ spacerSize: "XS" }),
              uiComponent.linkButton({
                buttonLabel: "View in Dashboard",
                buttonUrl: `https://cloud.trigger.dev/orgs/${org.slug}`,
                buttonStyle: "SECONDARY",
              }),
            ];
          });

          cards.push({
            key: "organizations",
            timeToLiveSeconds: 300,
            components: [
              uiComponent.container({
                components: [
                  uiComponent.text({
                    text: "Organizations",
                    textSize: "L",
                    textColor: "NORMAL",
                  }),
                  uiComponent.spacer({ spacerSize: "M" }),
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
                  components: [
                    uiComponent.text({
                      text: "Projects",
                      textSize: "L",
                      textColor: "NORMAL",
                    }),
                    uiComponent.spacer({ spacerSize: "M" }),
                    uiComponent.text({
                      text: "No projects found",
                      textSize: "S",
                      textColor: "MUTED",
                    }),
                  ],
                }),
              ],
            });
            break;
          }

          const projectComponents = allProjects.slice(0, 10).flatMap((project, index) => {
            return [
              ...(index > 0 ? [uiComponent.divider()] : []),
              uiComponent.text({
                text: project.name,
                textSize: "M",
                textColor: "NORMAL",
              }),
              uiComponent.spacer({ spacerSize: "XS" }),
              uiComponent.row({
                left: uiComponent.badge({
                  badgeLabel: project.version,
                  badgeColor: project.version === "V3" ? "GREEN" : "GRAY",
                }),
                right: uiComponent.linkButton({
                  buttonLabel: "View",
                  buttonUrl: `https://cloud.trigger.dev/orgs/${project.orgSlug}/projects/${project.slug}`,
                  buttonStyle: "SECONDARY",
                }),
              }),
            ];
          });

          cards.push({
            key: "projects",
            timeToLiveSeconds: 300,
            components: [
              uiComponent.container({
                components: [
                  uiComponent.text({
                    text: "Projects",
                    textSize: "L",
                    textColor: "NORMAL",
                  }),
                  uiComponent.spacer({ spacerSize: "M" }),
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

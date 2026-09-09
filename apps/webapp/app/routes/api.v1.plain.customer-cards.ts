import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { timingSafeEqual } from "crypto";
import { uiComponent } from "@team-plain/ui-components";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { generateImpersonationToken } from "~/services/impersonation.server";
import {
  answerAllCardKeys,
  emailLookupCandidates,
  PlainCustomerCardRequestSchema,
} from "~/utils/plainCustomerCards";

function sanitizeHeaders(
  request: Request,
  skipHeaders?: string[]
): Partial<Record<string, string>> {
  const authHeaderName = (env.PLAIN_CUSTOMER_CARDS_HEADERS || "Authorization").toLowerCase();
  const defaultSkipHeaders = skipHeaders || [authHeaderName, "cookie"];
  const sanitizedHeaders: Partial<Record<string, string>> = {};

  for (const [key, value] of request.headers.entries()) {
    if (!defaultSkipHeaders.includes(key.toLowerCase())) {
      sanitizedHeaders[key] = value;
    }
  }

  return sanitizedHeaders;
}

// Authenticate the request from Plain
function authenticatePlainRequest(request: Request): boolean {
  const authHeaderName = env.PLAIN_CUSTOMER_CARDS_HEADERS || "Authorization";
  const authHeader = request.headers.get(authHeaderName);
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

  // Use constant-time comparison to prevent timing attacks
  const encoder = new TextEncoder();
  const tokenBuffer = encoder.encode(token);
  const secretBuffer = encoder.encode(expectedSecret);
  if (tokenBuffer.byteLength !== secretBuffer.byteLength) {
    return false;
  }
  return timingSafeEqual(tokenBuffer, secretBuffer);
}

export async function action({ request }: ActionFunctionArgs) {
  // Only accept POST requests
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // Authenticate the request
  if (!authenticatePlainRequest(request)) {
    logger.warn("Unauthorized Plain customer card request", {
      headers: sanitizeHeaders(request),
    });
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse JSON with separate error handling for malformed JSON
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    // Handle JSON parsing errors as client errors (400) instead of server errors (500)
    if (error instanceof SyntaxError || error instanceof TypeError) {
      logger.warn("Malformed JSON in Plain customer card request", {
        error: error.message,
      });
      return json({ error: "Invalid JSON in request body" }, { status: 400 });
    }
    // Re-throw unexpected errors to be caught by outer catch
    throw error;
  }

  // Validate the request body schema
  const parsed = PlainCustomerCardRequestSchema.safeParse(body);

  if (!parsed.success) {
    logger.warn("Invalid Plain customer card request", {
      errors: parsed.error.issues,
    });
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const { customer, cardKeys } = parsed.data;

    const userInclude = {
      orgMemberships: {
        where: {
          organization: { deletedAt: null },
        },
        include: {
          organization: {
            include: {
              projects: {
                where: { deletedAt: null },
                take: 10,
                orderBy: { createdAt: "desc" as const },
              },
            },
          },
        },
      },
    };

    // The external id is ours (`User.id`), so it's tried first. Falling back to email when it
    // doesn't resolve covers a stale id — one naming a user row that no longer exists — instead of
    // leaving the card blank for a customer we could still identify.
    const byExternalId = customer.externalId
      ? await prisma.user.findFirst({ where: { id: customer.externalId }, include: userInclude })
      : null;

    // Emails aren't stored consistently cased, so try the address as sent and then its lowercased
    // form — see `emailLookupCandidates`. Both are exact matches on the unique index.
    const findByEmail = async () => {
      for (const email of emailLookupCandidates(customer.email)) {
        const match = await prisma.user.findFirst({ where: { email }, include: userInclude });
        if (match) return match;
      }
      return null;
    };

    const user = byExternalId ?? (await findByEmail());

    // An external id we set ourselves that no longer resolves is an anomaly worth seeing, even
    // though the email match keeps the card useful — otherwise the stale link stays invisible.
    if (customer.externalId && !byExternalId) {
      logger.warn("Plain customer card external id did not resolve", {
        resolvedByEmail: !!user,
      });
    }

    /**
     * Impersonation is offered only when the customer matched on `externalId` — a value we set
     * ourselves from `User.id`.
     *
     * Matching on email is a weaker claim: the address on a Plain customer isn't verified, and for
     * customers created outside our own writes it comes from whoever sent the message. Offering a
     * one-click impersonation link off the back of that would let an unverified address stand in
     * for an account, so email-matched customers get the account rows without it.
     *
     * Derived from which lookup actually matched, not from whether an external id was *sent* — an
     * id that misses and falls through to email must not unlock impersonation.
     */
    const canImpersonate = Boolean(byExternalId) && env.ADMIN_DASHBOARD_ENABLED;

    // No matching user: still answer every requested key, with no data so Plain hides the cards.
    if (!user) {
      // Presence flags only — the identifiers themselves don't need to persist in log storage.
      logger.info("User not found for Plain customer card request", {
        hasExternalId: !!customer.externalId,
        hasEmail: !!customer.email,
      });
      return json({ cards: answerAllCardKeys(cardKeys, []) });
    }

    // Build cards based on requested cardKeys
    const cards = [];

    const accountDetailsKey = env.PLAIN_CUSTOMER_CARDS_KEY || "account-details";
    for (const cardKey of cardKeys) {
      switch (cardKey) {
        case accountDetailsKey: {
          // Only mint a token when the button will actually be rendered — see `canImpersonate`.
          const impersonationComponents = canImpersonate
            ? [
                uiComponent.spacer({ size: "M" }),
                uiComponent.divider({ spacingSize: "M" }),
                uiComponent.spacer({ size: "M" }),
                uiComponent.linkButton({
                  label: "Impersonate User",
                  // The one-time token is what protects this link against CSRF.
                  url: `${env.APP_ORIGIN}/admin/impersonate?impersonate=${user.id}&impersonationToken=${encodeURIComponent(
                    await generateImpersonationToken(user.id)
                  )}`,
                }),
              ]
            : [];

          cards.push({
            key: accountDetailsKey,
            timeToLiveSeconds: 15,
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
                  ...impersonationComponents,
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
            (membership: (typeof user.orgMemberships)[0], index: number) => {
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
                      text: `${projectCount} recent project${projectCount !== 1 ? "s" : ""}`,
                      size: "S",
                      color: "MUTED",
                    }),
                  ],
                }),
                uiComponent.spacer({ size: "XS" }),
                uiComponent.linkButton({
                  label: "View in Dashboard",
                  url: `${env.APP_ORIGIN}/@/orgs/${org.slug}`,
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

          const projectComponents = allProjects
            .slice(0, 10)
            .flatMap((project: (typeof allProjects)[0] & { orgSlug: string }, index: number) => {
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
                      url: `${env.APP_ORIGIN}/@/orgs/${project.orgSlug}/projects/${project.slug}`,
                    }),
                  ],
                }),
              ];
            });

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
          // Unknown card key - answered with no data by answerAllCardKeys below.
          logger.info("Unknown card key requested", { cardKey });
          break;
      }
    }

    return json({ cards: answerAllCardKeys(cardKeys, cards) });
  } catch (error) {
    logger.error("Error processing Plain customer card request", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return json({ error: "Internal server error" }, { status: 500 });
  }
}

import { PrismaClient } from ".prisma/client";
import { readFile } from "fs/promises";

const prisma = new PrismaClient();

async function readTemplateDocsFile(slug: string) {
  console.log(`📖 Reading template docs file for ${slug}...`);

  const path = `../../templates/docs/${slug}.md`;

  return readFile(path, "utf8");
}

async function seed() {
  console.log(`Database has been seeded. 🌱`);

  const basicStarter = {
    repositoryUrl: "https://github.com/triggerdotdev/basic-starter",
    imageUrl:
      "https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/10a0661d-dda6-4a70-d1b5-8576ad63bd00/public",
    title: "A blank starter project with a simple Custom Event trigger",
    shortTitle: "Basic Starter",
    description: "This is a great place to start if you're new to Trigger.",
    priority: 0,
    services: [],
    workflowIds: ["basic-starter"],
    markdownDocs: await readTemplateDocsFile("basic-starter"),
    runLocalDocs: await readTemplateDocsFile("basic-starter-local"),
  };

  const githubStarsToSlack = {
    repositoryUrl: "https://github.com/triggerdotdev/github-stars-to-slack",
    imageUrl:
      "https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/10a0661d-dda6-4a70-d1b5-8576ad63bd00/public",
    title: "Slack notifications when a GitHub repo is starred",
    shortTitle: "GitHub stars to Slack",
    description:
      "When a GitHub repo is starred, post information about the user to Slack",
    priority: 1,
    services: ["github", "slack"],
    workflowIds: ["github-stars-to-slack"],
    markdownDocs: await readTemplateDocsFile("github-stars-to-slack"),
    runLocalDocs: await readTemplateDocsFile("github-stars-to-slack-local"),
  };

  const resendWelcomeDripCampaign = {
    repositoryUrl:
      "https://github.com/triggerdotdev/resend-welcome-drip-campaign",
    imageUrl:
      "https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/10a0661d-dda6-4a70-d1b5-8576ad63bd00/public",
    title: "Send a Welcome Drip Campaign to new users",
    shortTitle: "Resend.com drip campaign",
    description:
      "When a new user is created, send them a Welcome Drip Campaign from Resend.com and react.email",
    priority: 2,
    services: ["resend"],
    workflowIds: ["resend-welcome-drip-campaign"],
    markdownDocs: await readTemplateDocsFile("resend-welcome-drip-campaign"),
    runLocalDocs: await readTemplateDocsFile(
      "resend-welcome-drip-campaign-local"
    ),
  };

  await prisma.template.upsert({
    where: { slug: "basic-starter" },
    update: basicStarter,
    create: {
      slug: "basic-starter",
      ...basicStarter,
    },
  });

  await prisma.template.upsert({
    where: { slug: "github-stars-to-slack" },
    update: githubStarsToSlack,
    create: {
      slug: "github-stars-to-slack",
      ...githubStarsToSlack,
    },
  });

  await prisma.template.upsert({
    where: { slug: "resend-welcome-drip-campaign" },
    update: resendWelcomeDripCampaign,
    create: {
      slug: "resend-welcome-drip-campaign",
      ...resendWelcomeDripCampaign,
    },
  });
}

seed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

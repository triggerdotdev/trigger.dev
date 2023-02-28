import { PrismaClient } from ".prisma/client";
import { readFile } from "fs/promises";
import path from "node:path";

const prisma = new PrismaClient();

async function readTemplateDocsFile(slug: string) {
  const currentWorkingDir = process.cwd();

  const resolvedPath = path.resolve(
    currentWorkingDir,
    `./templates/docs/${slug}.md`
  );

  console.log(
    `📖 Reading template docs file for ${slug} at ${resolvedPath} being in ${currentWorkingDir}`
  );

  return readFile(resolvedPath, "utf8");
}

async function seed() {
  console.log(`Database has been seeded. 🌱`);

  const blankStarter = {
    repositoryUrl: "https://github.com/triggerdotdev/blank-starter",
    imageUrl:
      "https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/3812f076-38a2-4456-b809-2fc61dd77800/public",
    title: "A blank starter ready to run your own workflow",
    shortTitle: "Blank Starter",
    description:
      "This is a great place to start if you want to build your own workflow from scratch.",
    priority: 0,
    services: [],
    workflowIds: [],
    markdownDocs: await readTemplateDocsFile("blank-starter"),
  };

  const helloWorld = {
    repositoryUrl: "https://github.com/triggerdotdev/hello-world",
    imageUrl:
      "https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/634cfd11-e499-48ca-aaf5-b2404642f600/public",
    title: "A Hello World with a simple custom event trigger",
    shortTitle: "Hello World",
    description:
      "This is a great place to start if you're new to Trigger.dev and want to learn how to build a simple workflow.",
    priority: 10,
    services: [],
    workflowIds: ["hello-world"],
    markdownDocs: await readTemplateDocsFile("hello-world"),
  };

  const scheduledHealthcheck = {
    repositoryUrl: "https://github.com/triggerdotdev/scheduled-healthcheck",
    imageUrl:
      "https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/6dbe0780-1950-4645-6e64-f3eb65296900/public",
    title: "Run a scheduled healthcheck on your website every 5 minutes",
    shortTitle: "Scheduled Healthcheck",
    description:
      "This will run every 5 minutes and send a Slack message if a website url returns a non-200 response.",
    priority: 20,
    services: ["slack"],
    workflowIds: ["scheduled-healthcheck"],
    markdownDocs: await readTemplateDocsFile("scheduled-healthcheck"),
    runLocalDocs: await readTemplateDocsFile("scheduled-healthcheck-local"),
  };

  const githubStarsToSlack = {
    repositoryUrl: "https://github.com/triggerdotdev/github-stars-to-slack",
    imageUrl:
      "https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/5b3964be-9a7b-4a7e-1837-b283e501b900/public",
    title: "Post to Slack every time a GitHub repo is starred",
    shortTitle: "GitHub stars to Slack",
    description:
      "When a GitHub repo is starred, post information about the user to Slack.",
    priority: 30,
    services: ["github", "slack"],
    workflowIds: ["github-stars-to-slack"],
    markdownDocs: await readTemplateDocsFile("github-stars-to-slack"),
    runLocalDocs: await readTemplateDocsFile("github-stars-to-slack-local"),
  };

  const githubIssuesToSlack = {
    repositoryUrl: "https://github.com/triggerdotdev/github-issues-to-slack",
    imageUrl:
      "https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/1e3b4c17-70ce-484e-4ffe-2147fc873b00/public",
    title: "Post to Slack when a GitHub issue is created or modified",
    shortTitle: "GitHub issues to Slack",
    description:
      "When a GitHub issue is created or modified, post a message and link to the issue in a specific Slack channel.",
    priority: 40,
    services: ["github", "slack"],
    workflowIds: ["github-issues-to-slack"],
    markdownDocs: await readTemplateDocsFile("github-issues-to-slack"),
    runLocalDocs: await readTemplateDocsFile("github-issues-to-slack-local"),
  };

  const resendWelcomeDripCampaign = {
    repositoryUrl:
      "https://github.com/triggerdotdev/resend-welcome-drip-campaign",
    imageUrl:
      "https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/cce3b770-b6f9-40ef-baf3-f01c20686700/public",
    title: "Send an email drip campaign when a new user signs up",
    shortTitle: "Resend.com drip campaign",
    description:
      "When a new user is created, send them a welcome drip campaign from Resend.com and react.email.",
    priority: 50,
    services: ["resend"],
    workflowIds: ["resend-welcome-drip-campaign"],
    markdownDocs: await readTemplateDocsFile("resend-welcome-drip-campaign"),
    runLocalDocs: await readTemplateDocsFile(
      "resend-welcome-drip-campaign-local"
    ),
  };

  const supabaseToDiscord = {
    repositoryUrl: "https://github.com/triggerdotdev/supabase-to-discord",
    imageUrl:
      "https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/0d95eb90-cd8a-4342-cf22-bd1c81e56700/public",
    title: "Send a message to Discord from a Supabase webhook",
    shortTitle: "Supabase to Discord",
    description:
      "Send a message to a Discord channel when a new row is inserted into a Supabase table.",
    priority: 42,
    services: [],
    workflowIds: ["supabase-to-discord"],
    markdownDocs: await readTemplateDocsFile("supabase-to-discord"),
  };

  await prisma.template.updateMany({
    where: {
      slug: "basic-starter",
    },
    data: {
      isLive: false,
    },
  });

  await prisma.template.upsert({
    where: { slug: "blank-starter" },
    update: blankStarter,
    create: {
      slug: "blank-starter",
      ...blankStarter,
    },
  });

  await prisma.template.upsert({
    where: { slug: "hello-world" },
    update: helloWorld,
    create: {
      slug: "hello-world",
      ...helloWorld,
    },
  });

  await prisma.template.upsert({
    where: { slug: "scheduled-healthcheck" },
    update: scheduledHealthcheck,
    create: {
      slug: "scheduled-healthcheck",
      ...scheduledHealthcheck,
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
    where: { slug: "github-issues-to-slack" },
    update: githubIssuesToSlack,
    create: {
      slug: "github-issues-to-slack",
      ...githubIssuesToSlack,
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

  await prisma.template.upsert({
    where: { slug: "supabase-to-discord" },
    update: supabaseToDiscord,
    create: {
      slug: "supabase-to-discord",
      ...supabaseToDiscord,
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

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const templatesDir = process.argv[2];
if (!templatesDir) {
  console.error("Please provide a path to the templates directory");
  process.exit(1);
}

async function updateTemplate(templateName, branchName) {
  const templateDir = path.join(templatesDir, templateName);

  if (fs.statSync(templateDir).isDirectory()) {
    console.log(
      `Updating dependencies to @next for template '${templateName}'`
    );

    // Get the current branch and exit unless it's main
    const currentBranch = await execAsync(
      `cd ${templateDir} && git rev-parse --abbrev-ref HEAD`
    );

    if (currentBranch !== "main") {
      console.error(
        `Current branch is '${currentBranch}' for template '${templateName}'`
      );
      return;
    }

    // Make sure we're on the main branch and there are no uncommitted changes
    await execAsync(`cd ${templateDir} && git checkout main`);

    // Make sure there are no uncommitted changes
    const preStatus = await execAsync(`cd ${templateDir} && git status`);

    if (!preStatus.includes("nothing to commit")) {
      console.error(
        `There are uncommitted changes in template '${templateName}'`
      );
      return;
    }

    // Make sure we're up to date with the remote
    await execAsync(`cd ${templateDir} && git pull origin main`);

    // Create a new branch
    await execAsync(`cd ${templateDir} && git checkout -b ${branchName}`);

    // Find all the dependencies that start with @trigger.dev/
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(templateDir, "package.json"))
    );

    const dependencies = Object.keys(packageJson.dependencies).filter((dep) =>
      dep.startsWith("@trigger.dev/")
    );

    if (!dependencies) {
      console.error(`No dependencies defined for template '${templateName}'`);
      return;
    }

    const npmInstallCommand = `npm install ${dependencies
      .map((dep) => `${dep}@next`)
      .join(" ")}`;

    console.log(`Attempting ${npmInstallCommand}`);

    await execAsync(`cd ${templateDir} && ${npmInstallCommand}`);

    // Check if there are any changes
    const status = await execAsync(`cd ${templateDir} && git status`);

    if (!status.includes("modified:")) {
      console.log(`No changes for template '${templateName}'`);
      return;
    }

    console.log(`Changes for template '${templateName}':`, status);

    // Create a commit
    await execAsync(
      `cd ${templateDir} && git add package.json package-lock.json && git commit -m "[triggerbot] Updated packages to @next ${dependencies.join(
        ", "
      )}"`
    );

    // Push to remote
    await execAsync(`cd ${templateDir} && git push origin ${branchName}`);

    console.log(`Prerelease dependencies for template '${templateName}'`);
  } else {
    console.log(`Skipping '${templateName}'`);
  }
}

async function execAsync(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function main() {
  // Make a JSON request to https://app.trigger.dev/api/v1/templates and parse the response as an array of templates
  const templates = await fetch(
    "https://app.trigger.dev/api/v1/templates"
  ).then((res) => res.json());

  // Get the branch name from the args
  const branchName = process.argv[3];

  if (!branchName) {
    console.error("Please provide a branch name");
    process.exit(1);
  }

  for (const template of templates) {
    try {
      await updateTemplate(template.slug, branchName);
    } catch (error) {
      console.log(`Failed to update template '${template}'`, error);
    }
  }
}

main().catch(console.error);

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const templatesDir = process.argv[2];
if (!templatesDir) {
  console.error("Please provide a path to the templates directory");
  process.exit(1);
}

// patch is a path to a patch file
async function patchTemplate(templateName, patch, message) {
  const templateDir = path.join(templatesDir, templateName);

  if (fs.statSync(templateDir).isDirectory()) {
    console.log(`Patching template '${templateName}'`);
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

    // Apply the patch to the template repo
    await execAsync(`cd ${templateDir} && git apply ${patch}`);

    // Check if there are any changes
    const status = await execAsync(`cd ${templateDir} && git status`);

    if (!status.includes("modified:")) {
      console.log(`No changes for template '${templateName}'`);
      return;
    }

    console.log(`Changes for template '${templateName}':`, status);

    // Create a commit
    await execAsync(
      `cd ${templateDir} && git add -A && git commit -m "[triggerbot] ${message}"`
    );

    // Push to remote
    await execAsync(`cd ${templateDir} && git push origin main`);

    console.log(`Applied patch ${patch} to template '${templateName}'`);
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

// called like so: node scripts/patchTemplates.js /path/to/templates patchFile.patch "Patch message"
async function main() {
  // Make a JSON request to https://app.trigger.dev/api/v1/templates and parse the response as an array of templates
  const templates = await fetch(
    "https://app.trigger.dev/api/v1/templates"
  ).then((res) => res.json());

  for (const template of templates) {
    try {
      await patchTemplate(template.slug, process.argv[3], process.argv[4]);
    } catch (error) {
      console.log(`Failed to update template '${template.slug}'`, error);
    }
  }
}

main().catch(console.error);

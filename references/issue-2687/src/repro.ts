import "dotenv/config";
import { auth, tasks, runs, configure } from "@trigger.dev/sdk/v3";

const taskId = "issue-2687-task";

async function main() {
  if (!process.env.TRIGGER_SECRET_KEY) {
    console.error("TRIGGER_SECRET_KEY is not set. Please set it to your project's secret key.");
    process.exit(1);
  }

  const apiUrl = process.env.TRIGGER_API_URL || "https://api.trigger.dev";
  const branch = process.env.TRIGGER_PREVIEW_BRANCH;
  const secretKey = process.env.TRIGGER_SECRET_KEY;

  console.log(`Using API URL: ${apiUrl}`);
  console.log(`Using Secret Key: ${secretKey}`);
  if (branch) {
    console.log(`Using Branch: ${branch}`);
  }

  // 1. Generate the public token (Server-side)
  // We need the secret key for this part, so we use the environment variable which the SDK picks up automatically for this call.
  console.log("Generating public token...");
  try {
    // Ensure we are using the correct API URL for the generation as well, if it matters (it validates against the env).
    configure({ baseURL: apiUrl, accessToken: secretKey, previewBranch: branch });

    const token = await auth.createTriggerPublicToken(taskId);
    console.log("Token generated.");

    // 2. Trigger the task using the public token
    console.log(`Triggering task ${taskId}...`);

    // Use auth.withAuth to temporarily scope the SDK to the public token
    await auth.withAuth(
      { accessToken: token, baseURL: apiUrl, previewBranch: branch },
      async () => {
        const handle = await tasks.trigger(taskId, { foo: "bar" });
        console.log(`Task triggered. Run ID: ${handle.id}`);

        let tokenToUse = token;
        if (handle.publicAccessToken) {
          console.log("Received publicAccessToken in handle, using it for realtime.");
          console.log(`Public Access Token: ${handle.publicAccessToken}`);
          tokenToUse = handle.publicAccessToken;
        } else {
          console.log("Using initial token for subsequent requests.");
        }

        // 3. Access Run details (Simulating Realtime/Read access)
        // If the token changed (which it might if the API returns a specific read-only token), we should use that.

        if (tokenToUse !== token) {
          await auth.withAuth(
            { accessToken: tokenToUse, baseURL: apiUrl, previewBranch: branch },
            async () => {
              console.log(`Subscribing to run ${handle.id} with new token...`);
              for await (const run of runs.subscribeToRun(handle.id)) {
                console.log(`Run update received. Status: ${run.status}`);
                break;
              }
            }
          );
        } else {
          console.log(`Subscribing to run ${handle.id} with initial token...`);
          for await (const run of runs.subscribeToRun(handle.id)) {
            console.log(`Run update received. Status: ${run.status}`);
            break;
          }
        }

        console.log("Realtime/Read access verified.");
      }
    );
  } catch (error) {
    console.error("Error:", error);
  }
}

main();

import { execPromise } from "./utils.mjs";

// git install check
try {
  await execPromise("git --version");
} catch (error) {
  console.error("Git not installed or missing from PATH.");
  process.exit(0);
}

// submodule sync
try {
  const { stdout, stderr } = await execPromise("git submodule sync --recursive");

  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
} catch (error) {
  console.error("Error during submodule sync.");
  process.exit(1);
}

// submodule update
try {
  const { stdout, stderr } = await execPromise("git submodule update --init --recursive");

  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
} catch (error) {
  console.error("Error during submodule update.");
  process.exit(1);
}

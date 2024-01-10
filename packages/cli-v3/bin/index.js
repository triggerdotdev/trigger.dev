#!/usr/bin/env node
const { spawn } = require("child_process");
const path = require("path");
const semver = require("semver");

const MIN_NODE_VERSION = "18.18.0";

let cliProcess;

function run() {
  if (semver.lt(process.versions.node, MIN_NODE_VERSION)) {
    console.error(
      `\`trigger.dev\` requires at least Node.js v${MIN_NODE_VERSION}. You are using v${process.versions.node}. Please update your version of Node.js.

Consider using a Node.js version manager such as https://github.com/nvm-sh/nvm.`
    );
    process.exitCode = 1;
    return;
  }

  return spawn(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-vm-modules",
      ...process.execArgv,
      path.join(__dirname, "../dist/cli.js"),
      ...process.argv.slice(2),
    ],
    {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
      },
    }
  )
    .on("exit", (code) => process.exit(code === undefined || code === null ? 0 : code))
    .on("message", (message) => {
      if (process.send) {
        process.send(message);
      }
    })
    .on("disconnect", () => {
      if (process.disconnect) {
        process.disconnect();
      }
    });
}

if (module === require.main) {
  cliProcess = run();
  process.on("SIGINT", () => {
    cliProcess && cliProcess.kill();
  });
  process.on("SIGTERM", () => {
    cliProcess && cliProcess.kill();
  });
}

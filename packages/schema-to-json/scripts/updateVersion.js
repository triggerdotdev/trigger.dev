#!/usr/bin/env node

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the package.json
const packageJsonPath = join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

// Read the root package.json to get the version
const rootPackageJsonPath = join(__dirname, "..", "..", "..", "package.json");
const rootPackageJson = JSON.parse(readFileSync(rootPackageJsonPath, "utf-8"));

// Update the version
packageJson.version = rootPackageJson.version;

// Write back the package.json
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");

console.log(`Updated @trigger.dev/schema-to-json version to ${packageJson.version}`);
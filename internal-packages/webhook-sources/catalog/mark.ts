import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const id = args[0];
if (!id || id.startsWith("--")) {
  console.error(
    "usage: mark.ts <providerId> [--status <s>] [--check k1,k2,...] [--owner <name>] [--note <text>]"
  );
  process.exit(1);
}

const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const path = fileURLToPath(new URL("./providers.json", import.meta.url));
const catalog = JSON.parse(readFileSync(path, "utf8"));
const provider = catalog.providers.find((p: { id: string }) => p.id === id);
if (!provider) {
  console.error(`provider not found: ${id}`);
  process.exit(1);
}

const status = flag("status");
if (status) {
  if (!catalog.statusValues.includes(status)) {
    console.error(`invalid status ${status}; one of ${catalog.statusValues.join(", ")}`);
    process.exit(1);
  }
  provider.status = status;
}

const newTier = flag("tier");
if (newTier) {
  const keys: string[] | undefined = catalog.definitionOfDone[newTier];
  if (!keys) {
    console.error(
      `invalid tier ${newTier}; one of ${Object.keys(catalog.definitionOfDone).join(", ")}`
    );
    process.exit(1);
  }
  provider.tier = newTier;
  provider.checklist = Object.fromEntries(keys.map((k) => [k, provider.checklist[k] ?? false]));
}

const newPreset = flag("preset");
if (newPreset !== undefined) provider.preset = newPreset === "null" ? null : newPreset;

const check = flag("check");
if (check) {
  const dodKeys: string[] = catalog.definitionOfDone[provider.tier] ?? [];
  for (const key of check
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!dodKeys.includes(key)) {
      console.error(`checklist key '${key}' not in ${provider.tier} DoD (${dodKeys.join(", ")})`);
      process.exit(1);
    }
    provider.checklist[key] = true;
  }
}

const owner = flag("owner");
if (owner !== undefined) provider.owner = owner === "null" ? null : owner;

const note = flag("note");
if (note !== undefined) provider.notes = note;

writeFileSync(path, JSON.stringify(catalog, null, 2) + "\n");
const done = Object.values(provider.checklist).filter(Boolean).length;
console.log(
  `${id}: status=${provider.status} checklist=${done}/${Object.keys(provider.checklist).length} owner=${provider.owner ?? "-"}`
);

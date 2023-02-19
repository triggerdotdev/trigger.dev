import { IndentationText, NewLineKind, Project, QuoteKind } from "ts-morph";
import { Service } from "core/service/types";
import fs from "fs/promises";
import path from "path";
import { generateInputOutputSchemas } from "generators/combineSchemas";
import { getTypesFromSchema } from "generators/generateTypes";
import rimraf from "rimraf";
import { makeAnyOf } from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";

const appDir = process.cwd();

export async function generateService(service: Service) {
  const basePath = `generated-integrations/${service.service}`;

  //remove folder
  const absolutePath = path.join(appDir, "../..", basePath);

  console.log(`Removing ${absolutePath}...`);
  rimraf.sync(absolutePath);

  console.log(`Generating SDK for ${service.service}...`);

  const project = new Project({
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
      newLineKind: NewLineKind.LineFeed,
      quoteKind: QuoteKind.Double,
      usePrefixAndSuffixTextForRename: false,
      useTrailingCommas: true,
    },
  });

  try {
    project.createDirectory(absolutePath);
    await generateTemplatedFiles(project, absolutePath, service);
    await generateFunctionsAndTypes(project, absolutePath, service);
    await project.save();
  } catch (e) {
    console.error(e);
  }
}

function toFriendlyTypeName(original: string) {
  //convert the input string to TitleCase, strip out any non alpha characters and strip out spaces
  return original
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, function (str: string) {
      return str.toUpperCase();
    })
    .replace(/[^a-zA-Z]/g, "")
    .replace(/\s/g, "");
}

async function generateTemplatedFiles(
  project: Project,
  basePath: string,
  service: Service
) {
  await createFileAndReplaceVariables(
    "package.json",
    project,
    basePath,
    service
  );
  await createFileAndReplaceVariables(
    "tsconfig.json",
    project,
    basePath,
    service
  );
  await createFileAndReplaceVariables("README.md", project, basePath, service);
  await createFileAndReplaceVariables(
    "tsup.config.ts",
    project,
    basePath,
    service
  );
  return;
}

async function createFileAndReplaceVariables(
  filename: string,
  project: Project,
  basePath: string,
  service: Service
) {
  const originalText = await fs.readFile(
    `src/trigger/sdk/templates/${filename}.template`,
    { encoding: "utf-8" }
  );

  //replace any text that matches {service.[key]} with the value from the service object
  const text = originalText.replace(
    /{service.([a-zA-Z0-9]+)}/g,
    (match: string, key: string) => {
      return (service as any)[key] as string;
    }
  );

  const file = project.createSourceFile(`${basePath}/${filename}`, text, {
    overwrite: true,
  });
  file.formatText();
  return;
}

async function generateFunctionsAndTypes(
  project: Project,
  basePath: string,
  service: Service
) {
  const { actions } = service;

  const typeSchemas: JSONSchema[] = [];
  const functions: Record<string, string> = {};
  //loop through actions
  for (const key in actions) {
    const action = actions[key];

    //generate schemas for input and output
    const name = toFriendlyTypeName(action.name);
    const schemas = generateInputOutputSchemas(action.spec, name);

    //add schemas to the array
    schemas.input && typeSchemas.push(schemas.input);
    typeSchemas.push(schemas.output);

    functions[action.name] = `
${action.description ? `/** ${action.description} */` : ""}
export async function ${action.name}(
  /** This key should be unique inside your workflow */
  key: string,
  ${
    schemas.input
      ? `/** The params for this call */
  params: ${schemas.input.title}`
      : ""
  }
): Promise<${schemas.output.title}> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call ${action.name} outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "${service.service}",
    endpoint: "${action.name}",
    params,
  });

  return output;
}
      `;
  }

  const combinedSchema: JSONSchema = makeAnyOf(
    `${toFriendlyTypeName(service.service)}Types}`,
    typeSchemas
  );

  const allTypes = await getTypesFromSchema(
    combinedSchema,
    `${service.service}Types`
  );

  const typesFile = project.createSourceFile(
    `${basePath}/src/types.ts`,
    allTypes,
    {
      overwrite: true,
    }
  );
  typesFile.formatText();

  const functionsFile = project.createSourceFile(
    `${basePath}/src/index.ts`,
    `import { getTriggerRun } from "@trigger.dev/sdk";
      import { ${typeSchemas
        .map((t) => t && t.title)
        .join(", ")} } from "./types";
      ${Object.values(functions).join("")}`,
    {
      overwrite: true,
    }
  );
  functionsFile.formatText();
}

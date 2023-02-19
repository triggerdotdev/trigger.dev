import { IndentationText, NewLineKind, Project, QuoteKind } from "ts-morph";
import { Service } from "core/service/types";
import fs from "fs/promises";
import path from "path";
import { generateInputOutputSchemas } from "generators/combineSchemas";
import { getTypesFromSchema } from "generators/generateTypes";
import rimraf from "rimraf";
import { makeAnyOf } from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";
import { Action } from "core/action/types";

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
    const functionsData = await generateFunctionData(service);
    await createFunctionsAndTypesFiles(
      project,
      absolutePath,
      service,
      functionsData
    );
    await generateDocs(project, absolutePath, service, functionsData);
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

type FunctionData = {
  title: string;
  name: string;
  friendlyName: string;
  description: string;
  input: JSONSchema | undefined;
  output: JSONSchema;
  functionCode: string;
};

async function generateFunctionData(service: Service) {
  const { actions } = service;
  const functions: Record<string, FunctionData> = {};
  //loop through actions
  for (const key in actions) {
    const action = actions[key];

    //generate schemas for input and output
    const title = TitleCaseWithSpaces(action.name);
    const name = action.name;
    const friendlyName = toFriendlyTypeName(name);
    const schemas = generateInputOutputSchemas(action.spec, friendlyName);

    const functionCode = `
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

    const functionData: FunctionData = {
      title,
      name,
      friendlyName,
      description: action.description,
      input: schemas.input,
      output: schemas.output,
      functionCode,
    };
    functions[name] = functionData;
  }

  return functions;
}

async function createFunctionsAndTypesFiles(
  project: Project,
  basePath: string,
  service: Service,
  functionsData: Record<string, FunctionData>
) {
  const typeSchemas = Object.values(functionsData)
    .flatMap((f) => [f.input, f.output])
    .filter(Boolean) as JSONSchema[];

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
      ${Object.values(functionsData)
        .map((f) => f.functionCode)
        .join("")}`,
    {
      overwrite: true,
    }
  );
  functionsFile.formatText();
}

async function generateDocs(
  project: Project,
  basePath: string,
  service: Service,
  functionsData: Record<string, FunctionData>
) {
  const promises = Object.values(functionsData).map(async (f) => {
    //metadata and intro
    let markdown = `---
title: ${f.title}
sidebarTitle: ${f.title}
description: ${f.description}
---

${f.description}`;

    //Base params
    markdown += `
    
## Params
    
<ParamField path="key" type="string" required={true}>
  A unique string. Please see the [Keys and Resumability](/guides/resumability)
  doc for more info.
</ParamField>`;

    //Input schema
    if (f.input) {
      markdown += "\n\n";
      markdown += generateParamFieldFromSchema("params", true, f.input);
    }

    project.createSourceFile(
      `${basePath}/docs/${fileNameFromTitleCase(f.friendlyName)}.mdx`,
      markdown,
      {
        overwrite: true,
      }
    );

    project.createSourceFile(
      `${basePath}/docs/${fileNameFromTitleCase(f.friendlyName)}.json`,
      JSON.stringify(f.input, null, 2),
      {
        overwrite: true,
      }
    );

    return Promise.resolve();
  });

  await Promise.all(promises);
  return;
}

function fileNameFromTitleCase(str: string) {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s-]+/g, "-")
    .toLowerCase();
}

function TitleCaseWithSpaces(str: string) {
  return str
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[\s-]+/g, " ")
    .replace(/^./, function (str: string) {
      return str.toUpperCase();
    });
}

function generateParamFieldFromSchema(
  key: string,
  required: boolean,
  schema: JSONSchema | boolean
): string {
  if (typeof schema === "boolean") return "";
  const { description } = schema;
  let output = `<ParamField path="${key}" type="${schema.type}" required={${required}}>\n`;
  if (description) {
    output += `   ${description}\n`;
  }

  if (schema.type === "object") {
    if (schema.properties) {
      output += Object.entries(schema.properties)
        .map(
          ([k, v]) =>
            ` ${generateParamFieldFromSchema(
              k,
              schema.required?.find((r) => r === k) != undefined ?? false,
              v
            )}`
        )
        .join("\n");
    }
    if (schema.additionalProperties) {
      output += Object.entries(schema.additionalProperties)
        .map(
          ([k, v]) =>
            ` ${generateParamFieldFromSchema(
              k,
              schema.required?.find((r) => r === k) != undefined ?? false,
              v
            )}`
        )
        .join("\n");
    }
  }

  output += `</ParamField>`;
  return output;
}

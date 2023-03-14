import { createJSONPointer } from "core/common/pointer";
import { JSONSchema, SchemaRef } from "core/schemas/types";
import { Service } from "core/service/types";
import fs from "fs/promises";
import { createMinimalSchema } from "generators/combineSchemas";
import { getTypesFromSchema } from "generators/generateTypes";
import pointer from "json-pointer";
import { parseSchema } from "json-schema-to-zod";
import path from "path";
import rimraf from "rimraf";
import { IndentationText, NewLineKind, Project, QuoteKind } from "ts-morph";
import { generateDocs } from "./generateDocs";
import { FunctionData } from "./types";
import {
  TitleCaseWithSpaces,
  toCamelCase,
  toFriendlyTypeName,
  toTitleCase,
} from "./utilities";

const appDir = process.cwd();

export async function generateService(service: Service) {
  const basePath = `generated-integrations/${service.service}`;
  const absolutePath = path.join(appDir, "../..", basePath);

  //read existing package.json if there is one
  let originalPackageJson: string | undefined = undefined;
  try {
    originalPackageJson = await fs.readFile(`${absolutePath}/package.json`, {
      encoding: "utf-8",
    });
  } catch (e) {
    //do nothing
  }

  //read existing CHANGELOG.md if there is one
  let originalChangelog: string | undefined = undefined;
  try {
    originalChangelog = await fs.readFile(`${absolutePath}/CHANGELOG.md`, {
      encoding: "utf-8",
    });
  } catch (e) {
    //do nothing
  }

  //remove folder
  console.log(`Removing ${absolutePath}`);
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
    if (originalPackageJson) {
      project.createSourceFile(
        `${absolutePath}/package.json`,
        originalPackageJson
      );
    } else {
      await createFileAndReplaceVariables(
        "package.json",
        project,
        absolutePath,
        service
      );
    }

    if (originalChangelog) {
      project.createSourceFile(
        `${absolutePath}/CHANGELOG.md`,
        originalChangelog
      );
    }

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

async function generateTemplatedFiles(
  project: Project,
  basePath: string,
  service: Service
) {
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

async function generateFunctionData(service: Service) {
  const { actions, webhooks } = service;
  const functions: Record<string, FunctionData> = {};
  //loop through actions
  if (actions) {
    for (const key in actions) {
      const action = actions[key];

      //generate schemas for input and output
      const title = TitleCaseWithSpaces(action.name);
      const name = action.name;
      const friendlyName = toFriendlyTypeName(name);
      const inputName = action.spec.input ? `${friendlyName}Input` : undefined;
      const outputName = action.spec.output
        ? `${friendlyName}Output`
        : undefined;

      const functionCode = `
${action.description ? `/** ${action.description} */` : ""}
export async function ${action.name}(
  /** This key should be unique inside your workflow */
  key: string,
  ${
    inputName
      ? `/** The params for this call */
  params: Prettify<${inputName}>`
      : ""
  }
): Promise<Prettify<${outputName ?? "void"}>> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call ${action.name} outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "${service.service}",
    endpoint: "${action.name}",
    ${inputName ? "params," : "params: undefined,"}
  });

  return output;
}
      `;

      const functionData: FunctionData = {
        type: "action",
        title,
        name,
        friendlyName,
        description: action.description,
        inputRef: action.spec.input.body,
        outputRef: action.spec.output.responses.find((r) => r.success)?.schema,
        functionCode,
      };
      functions[name] = functionData;
    }
  }

  if (webhooks) {
    for (const key in webhooks) {
      const webhook = webhooks[key];

      for (const eventKey in webhook.events) {
        const event = webhook.events[eventKey];

        //generate schemas for input and output
        switch (webhook.subscription.type) {
          case "automatic": {
            const typeName = toTitleCase(event.name);
            let inputSpecTitle: undefined | string = undefined;
            let inputRef: undefined | SchemaRef = undefined;
            if (webhook.subscription.inputSchemaRef) {
              inputRef = webhook.subscription.inputSchemaRef;
              const ptr = createJSONPointer(
                webhook.subscription.inputSchemaRef
              );
              const inputSpec = pointer.get(service.schema, ptr);
              if (inputSpec) {
                inputSpecTitle = `${typeName}Input`;
              }
            }

            const title = event.metadata.title;
            const functionName = toCamelCase(`${typeName}Event`);
            const friendlyName = toFriendlyTypeName(functionName);

            const zodSchemaName = `${functionName}Schema`;

            const functionCode = `
${event.metadata.description ? `/** ${event.metadata.description} */` : ""}
function ${functionName}(
  ${
    inputSpecTitle
      ? `/** The params for this call */
  params: Prettify<${inputSpecTitle}>`
      : ""
  }
): TriggerEvent<typeof ${zodSchemaName}> {
  return {
    metadata: {
      type: "INTEGRATION_WEBHOOK",
      service: "${service.service}",
      name: "${event.name}",
      key: \`${event.key}\`,
      filter: {
        service: ["${service.service}"],
        event: ["${event.name}"],
      },
      source: ${inputSpecTitle ? "params" : "undefined"},
    },
    schema: ${zodSchemaName},
  }; 
}
      `;

            const functionData: FunctionData = {
              type: "event",
              title,
              name: functionName,
              friendlyName,
              description: event.metadata.description,
              inputRef,
              outputRef: event.outputSchemaRef,
              functionCode,
            };
            functions[functionName] = functionData;
            break;
          }
          case "manual": {
            throw new Error("Manual subscriptions not supported yet");
          }
        }
      }
    }
  }

  return functions;
}

async function createFunctionsAndTypesFiles(
  project: Project,
  basePath: string,
  service: Service,
  functionsData: Record<string, FunctionData>
) {
  const combinedSchema: JSONSchema = {
    title: `${toFriendlyTypeName(service.service)}Types`,
    allOf: Object.entries(functionsData).flatMap(([name, data]) => {
      const schemas: JSONSchema[] = [];

      if (data.inputRef) {
        schemas.push({
          title: `${data.friendlyName}Input`,
          $ref: data.inputRef,
        });
      }

      if (data.outputRef) {
        schemas.push({
          title: `${data.friendlyName}Output`,
          $ref: data.outputRef,
        });
      }

      return schemas;
    }),
    definitions: service.schema.definitions,
  };

  const importNames = Object.entries(functionsData).flatMap(([name, data]) => {
    const imports: string[] = [];
    if (data.inputRef) {
      imports.push(`${data.friendlyName}Input`);
    }
    if (data.outputRef) {
      imports.push(`${data.friendlyName}Output`);
    }
    return imports;
  });

  //uncomment to write intermediate schema to disk
  await fs.mkdir(basePath, { recursive: true });
  await fs.writeFile(
    `${basePath}/schema-optimized.json`,
    JSON.stringify(combinedSchema, null, 2)
  );

  let typesFileText = `import { z } from "zod";\n`;

  const allTypes = await getTypesFromSchema(
    combinedSchema,
    `${service.service}Types`
  );

  typesFileText += allTypes;

  typesFileText += `\nexport type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};`;

  //events used Zod schemas
  const zodPromises = Object.entries(functionsData)
    .filter(([name, data]) => data.type === "event" && data.outputRef)
    .map(async ([name, data]) => {
      if (!data.outputRef) throw new Error("No output ref");
      const minimalSchema = createMinimalSchema(
        data.outputRef,
        service.schema.definitions
      );
      minimalSchema.title = `${data.friendlyName}Output`;
      const schemaText = parseSchema(minimalSchema);
      const schemaName = `${data.name}Schema`;
      const code = `export const ${schemaName} = ${schemaText}`;
      return { name: schemaName, code };
    });
  const zodSchemas = await Promise.all(zodPromises);
  typesFileText += `\n${zodSchemas.map((z) => z.code).join("\n")}`;

  const typesFile = project.createSourceFile(
    `${basePath}/src/types.ts`,
    typesFileText,
    {
      overwrite: true,
    }
  );
  typesFile.formatText();

  //import the sdk, zod, the types and schemas
  const imports = `import { getTriggerRun } from "@trigger.dev/sdk";
  import type { TriggerEvent } from "@trigger.dev/sdk";
  import { z } from "zod";
    import { ${importNames.join(", ")}, Prettify ${
    zodSchemas.length > 0 ? `, ${zodSchemas.map((z) => z.name).join(", ")}` : ""
  } } from "./types";`;

  const functions = `${Object.values(functionsData)
    .map((f) => f.functionCode)
    .join("")}`;

  const eventFunctions = Object.values(functionsData).filter(
    (f) => f.type === "event"
  );
  const eventExport =
    eventFunctions.length > 0
      ? `export const events = { ${eventFunctions
          .map((f) => f.name)
          .join(", ")} };`
      : "";

  const functionsFile = project.createSourceFile(
    `${basePath}/src/index.ts`,
    `${imports}
    ${functions}
    ${eventExport}`,
    {
      overwrite: true,
    }
  );
  functionsFile.formatText();
}

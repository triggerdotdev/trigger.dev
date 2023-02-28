import { IndentationText, NewLineKind, Project, QuoteKind } from "ts-morph";
import { Service } from "core/service/types";
import fs from "fs/promises";
import path from "path";
import { generateInputOutputSchemas } from "generators/combineSchemas";
import { getTypesFromSchema } from "generators/generateTypes";
import rimraf from "rimraf";
import { makeAnyOf } from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";
import { FunctionData } from "./types";
import { generateDocs } from "./generateDocs";
import { TitleCaseWithSpaces, toFriendlyTypeName } from "./utilities";
import { AutoReffer } from "core/schemas/autoReffer";

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
  params: Prettify<${schemas.input.title}>`
      : ""
  }
): Promise<Prettify<${schemas.output?.title ?? "void"}>> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call ${action.name} outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "${service.service}",
    endpoint: "${action.name}",
    ${schemas.input ? "params," : "params: undefined,"}
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

  const reffer = new AutoReffer(combinedSchema, {
    refIfMoreThan: 4,
  });
  const optimizedSchema = reffer.optimize();

  //uncomment to write intermediate optimized schema to disk
  // await fs.mkdir(basePath, { recursive: true });
  // await fs.writeFile(
  //   `${basePath}/schema-optimized.json`,
  //   JSON.stringify(optimizedSchema, null, 2)
  // );

  let allTypes = await getTypesFromSchema(
    optimizedSchema,
    `${service.service}Types`
  );

  allTypes += `\nexport type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};`;

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
        .join(", ")}, Prettify } from "./types";
      ${Object.values(functionsData)
        .map((f) => f.functionCode)
        .join("")}`,
    {
      overwrite: true,
    }
  );
  functionsFile.formatText();
}

import { Command } from "commander";
import { promises as fs } from "node:fs";
import * as tsj from "ts-json-schema-generator";
type JSONSchema7Definition = NonNullable<tsj.Schema["definitions"]>[number];

const program = new Command();

program
  .command("convert")
  .description("Convert the TypeScript file to a schema file")
  .argument("<original_file_path>", "The file path to TypeScript file")
  .option("-t, --type <type>", "The single type to generate")
  .option(
    "-m, --mode <mode>",
    "The mode to use: typescript or jsonschema. Default is typescript"
  )
  .action(
    async (
      original_file_path: string,
      options: {
        type?: string;
        mode?: "typescript" | "jsonschema";
      }
    ) => {
      try {
        const config: tsj.Config = {
          path: original_file_path,
          expose: "all",
          jsDoc: "extended",
          type: options.type ?? "*",
          skipTypeCheck: true,
        };

        const schema = tsj.createGenerator(config).createSchema(config.type);

        if (options.mode === undefined || options.mode === "typescript") {
          //output each definition as an exported const
          let typescriptFileText = `import { JSONSchema } from "core/schemas/types";\n\n`;

          if (!schema.definitions) {
            throw new Error("No definitions found");
          }

          //replace $refs with pointing at other consts

          //loop through each definition and change $refs to point to the Schema instead
          Object.entries(schema.definitions).forEach(([name, definition]) => {
            const schemaName = schemaFriendlyName(name);
            let text = `export const ${schemaName}: JSONSchema = ${JSON.stringify(
              definition,
              null,
              2
            )};\n\n`;

            //look for { $ref: "#/definitions/MyTypeName" } and replace with MyTypeNameSchema
            text = text.replace(
              /\{\s*"\$ref":\s*"#\/definitions\/([a-zA-Z0-9%()-|]+)"\s*\}/g,
              (match: string, name: string) => {
                return schemaFriendlyName(name);
              }
            );
            typescriptFileText += text;
          });

          //get original file path minus the extension
          const originalFilePathMinusExtension = original_file_path.replace(
            ".ts",
            ""
          );
          const tsFileName = `${originalFilePathMinusExtension}_schemas.ts`;
          await fs.writeFile(tsFileName, typescriptFileText);
          console.log("Successfully created JSON Schema file", tsFileName);
        } else {
          const jsonSchemaFilePath = `${original_file_path}.json`;
          await fs.writeFile(
            jsonSchemaFilePath,
            JSON.stringify(schema, null, 2)
          );

          console.log(
            "Successfully created JSON Schema file",
            jsonSchemaFilePath
          );
        }
      } catch (e) {
        console.error(e);
      }
    }
  );

function schemaFriendlyName(name: string) {
  //look for Record<string, whatever> and replace with RecordStringWhatever
  name = decodeURIComponent(name);
  //replace any funky characters
  name = name.replace(
    /Record<string,\s*([a-zA-Z%()-|]+)>/g,
    (match: string, n: string) => {
      return `${n.replace(/[-()%|]/g, "")}Record`;
    }
  );

  return `${capitalizeFirstLetter(name)}Schema`;
}

//Capitalize the first letter of a string
function capitalizeFirstLetter(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

program.parseAsync(process.argv);

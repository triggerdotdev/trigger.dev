import { Command } from "commander";
import { transformNullables } from "core/schemas/transformNullables";
import { promises as fs } from "node:fs";

const program = new Command();

program
  .command("convert")
  .description("Convert an OpenAPI 3 spec to 3.1")
  .argument("<original_file_path>", "The file path to the original spec file")
  .action(async (original_file_path: string) => {
    //get original file path minus the extension
    const originalFilePathMinusExtension = original_file_path.replace(
      ".json",
      ""
    );

    try {
      const originalFile = await fs.readFile(original_file_path, "utf8");
      const spec = JSON.parse(originalFile);
      transformNullables(spec);
      const newSpecFilePath = `${originalFilePathMinusExtension}_3.1.json`;
      await fs.writeFile(newSpecFilePath, JSON.stringify(spec, null, 2));
      console.log(`New spec file created at ${newSpecFilePath}`);
    } catch (e) {
      console.error(e);
    }
  });

program.parseAsync(process.argv);

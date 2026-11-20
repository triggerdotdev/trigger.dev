const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

// Caps on inflated source, so a small bundle can't exhaust memory or disk.
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

// Get the file paths from command line arguments
let [jsonFilePath, destDir] = process.argv.slice(2);

if (!jsonFilePath || !destDir) {
  console.error("Usage: node script.js <json-file-path> <destination-directory>");
  process.exit(1);
}

const toMiB = (bytes) => `${bytes / 1024 / 1024} MiB`;

function decompressContent(base64Encoded, filePath) {
  const compressedData = Buffer.from(base64Encoded, "base64");

  try {
    return zlib.inflateSync(compressedData, { maxOutputLength: MAX_FILE_BYTES });
  } catch (error) {
    if (error.code !== "ERR_BUFFER_TOO_LARGE") throw error;
    throw new Error(
      `Refusing ${filePath}: inflates past the ${toMiB(MAX_FILE_BYTES)} per-file limit`
    );
  }
}

try {
  // Read and parse the JSON file
  const jsonContent = fs.readFileSync(jsonFilePath, "utf8");

  const data = JSON.parse(jsonContent)[0];

  console.log(data);

  const id = data.id;

  // The id becomes the extraction root, so it must be a single path component.
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new Error(`Unsafe worker id: ${id}`);
  }

  console.log(`Extracting files for: ${id} to ${destDir}`);

  destDir = path.join(destDir, id);

  console.log(`Extracting files to: ${destDir}`);

  // Resolve the extraction root once so we can keep every file inside it.
  const extractionRoot = path.resolve(destDir);

  // Inflate and check every file before writing any, so a refused bundle writes nothing.
  const files = [];
  let totalBytes = 0;

  for (const file of data.metadata.sourceFiles) {
    const fullPath = path.resolve(extractionRoot, file.filePath);

    // Reject any path that escapes the extraction root (zip-slip via ../ etc.)
    if (fullPath !== extractionRoot && !fullPath.startsWith(extractionRoot + path.sep)) {
      throw new Error(`Refusing to write outside destination: ${file.filePath}`);
    }

    const inflated = decompressContent(file.contents, file.filePath);

    totalBytes += inflated.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `Refusing bundle: source inflates past the ${toMiB(MAX_TOTAL_BYTES)} total limit`
      );
    }

    files.push({ fullPath, contents: inflated.toString() });
  }

  fs.mkdirSync(extractionRoot, { recursive: true });

  for (const { fullPath, contents } of files) {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
    console.log(`Created file: ${fullPath}`);
  }

  console.log(`\nAll files have been extracted to: ${extractionRoot}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}

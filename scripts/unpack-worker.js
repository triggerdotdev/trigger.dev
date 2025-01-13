const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

// Get the file paths from command line arguments
let [jsonFilePath, destDir] = process.argv.slice(2);

if (!jsonFilePath || !destDir) {
  console.error("Usage: node script.js <json-file-path> <destination-directory>");
  process.exit(1);
}

// Function to decompress the content
function decompressContent(base64Encoded) {
  // Decode base64 string to buffer
  const compressedData = Buffer.from(base64Encoded, "base64");

  // Decompress the data
  const decompressedData = zlib.inflateSync(compressedData);

  // Convert buffer to string
  return decompressedData.toString();
}

try {
  // Read and parse the JSON file
  const jsonContent = fs.readFileSync(jsonFilePath, "utf8");

  const data = JSON.parse(jsonContent)[0];

  console.log(data);

  const id = data.id;

  console.log(`Extracting files for: ${id} to ${destDir}`);

  destDir = path.join(destDir, id);

  console.log(`Extracting files to: ${destDir}`);

  // Create the destination directory if it doesn't exist
  fs.mkdirSync(destDir, { recursive: true });

  // Process each item in the array
  const sourceFiles = data.metadata.sourceFiles;

  sourceFiles.forEach((file) => {
    // Decompress the contents
    const decompressedContent = decompressContent(file.contents);

    // Combine destination directory with file path
    const fullPath = path.join(destDir, file.filePath);

    // Create directory structure if it doesn't exist
    const dirPath = path.dirname(fullPath);
    fs.mkdirSync(dirPath, { recursive: true });

    // Write the decompressed content to the file
    fs.writeFileSync(fullPath, decompressedContent);

    console.log(`Created file: ${fullPath}`);
  });

  console.log(`\nAll files have been extracted to: ${destDir}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}

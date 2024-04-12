import { promises as fs } from "fs";
import path from "path";
import { execPromise } from "./utils.mjs";

const isWindows = process.platform === "win32";

// Define the application root and directories for generated files and proto files
const appRoot = process.cwd();
const generatedPath = path.join(appRoot, "src", "generated");
const protosPath = path.join(appRoot, "protos");
const pluginPath = path.join(
  appRoot,
  "node_modules",
  ".bin",
  isWindows ? "protoc-gen-ts_proto.cmd" : "protoc-gen-ts_proto"
);

// Ensure the generated directory exists
await fs.mkdir(generatedPath, { recursive: true });

// Define proto files
const protos = [
  "opentelemetry/proto/common/v1/common.proto",
  "opentelemetry/proto/resource/v1/resource.proto",
  "opentelemetry/proto/trace/v1/trace.proto",
  "opentelemetry/proto/collector/trace/v1/trace_service.proto",
  "opentelemetry/proto/metrics/v1/metrics.proto",
  "opentelemetry/proto/collector/metrics/v1/metrics_service.proto",
  "opentelemetry/proto/logs/v1/logs.proto",
  "opentelemetry/proto/collector/logs/v1/logs_service.proto",
];

// Use protoc with ts-proto to generate TypeScript files from proto files
for (const proto of protos) {
  const command =
    `protoc --plugin=protoc-gen-ts_proto="${pluginPath}" ` +
    `--ts_proto_out="${generatedPath}" ` +
    `--proto_path="${protosPath}" ` +
    `--ts_proto_opt=forceLong=bigint ` +
    `--ts_proto_opt=esModuleInterop=true ` +
    `--ts_proto_opt=env=node ` +
    `--ts_proto_opt=removeEnumPrefix=true ` +
    `--ts_proto_opt=lowerCaseServiceMethods=true ` +
    `--experimental_allow_proto3_optional ` +
    `"${path.join(protosPath, proto)}"`;
  try {
    const { stdout, stderr } = await execPromise(command);
    if (stdout) {
      console.log(stdout);
    } else {
      console.log(`Generated ts file for ${proto}`);
    }
    if (stderr) console.error(stderr);
  } catch (error) {
    console.error(`An error occurred during generation: ${error}`);
    process.exit(1);
  }
}

console.log("TypeScript files generated successfully.");

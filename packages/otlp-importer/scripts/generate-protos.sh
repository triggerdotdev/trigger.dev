#!/bin/bash

# Define the application root and directories for generated files and proto files
appRoot=$(pwd)
generatedPath="$appRoot/src/generated"
protosPath="$appRoot/protos"
pluginPath="$appRoot/node_modules/.bin/protoc-gen-ts_proto"

# Ensure the generated directory exists
mkdir -p "$generatedPath"

# Define proto files
protos=(
  "opentelemetry/proto/common/v1/common.proto"
  "opentelemetry/proto/resource/v1/resource.proto"
  "opentelemetry/proto/trace/v1/trace.proto"
  "opentelemetry/proto/collector/trace/v1/trace_service.proto"
  "opentelemetry/proto/metrics/v1/metrics.proto"
  "opentelemetry/proto/collector/metrics/v1/metrics_service.proto"
  "opentelemetry/proto/logs/v1/logs.proto"
  "opentelemetry/proto/collector/logs/v1/logs_service.proto"
)

# Use protoc with ts-proto to generate TypeScript files from proto files
for proto in "${protos[@]}"; do
  protoc --plugin=protoc-gen-ts_proto="$pluginPath" \
         --ts_proto_out="$generatedPath" \
         --proto_path="$protosPath" \
         --ts_proto_opt=forceLong=bigint \
         --ts_proto_opt=esModuleInterop=true \
         --ts_proto_opt=env=node \
         --ts_proto_opt=removeEnumPrefix=true \
         --ts_proto_opt=lowerCaseServiceMethods=true \
         --ts_proto_opt=oneof=unions \
         "$protosPath/$proto"
done

# Check for errors
if [ $? -eq 0 ]; then
  echo "TypeScript files generated successfully."
else
  echo "An error occurred during generation."
fi

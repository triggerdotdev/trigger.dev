#!/bin/bash

# Copy the .npmrc file into the build directory
echo "Copying .npmrc to build context..."
cp .npmrc /app/.npmrc

# Set the NPM_TOKEN environment variable for the build
export NPM_TOKEN=$1

# Run the npm install command
echo "Running npm install with NPM_TOKEN..."
pnpm install

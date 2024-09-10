#!/bin/bash

set -e

# Print the current working directory
echo "Updating packages in: $(pwd)"

corepack use pnpm@8.15.5
rm -rf **/node_modules

# Check if package-lock.json exists in the current directory
if [ -f "package-lock.json" ]; then
    echo "package-lock.json found. Running npm install..."
    npm install
    rm -rf **/node_modules
else
    echo "No package-lock.json found. Skipping npm install."
fi
corepack use yarn@4.2.2
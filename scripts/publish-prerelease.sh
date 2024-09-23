#!/bin/bash

set -e

# Use the first argument as version or 'v3-prerelease' if not available
version=${1:-'v3-prerelease'}

# Ensure git stage is clear
if [[ $(git status --porcelain) ]]; then
    echo "Your git status is not clean. Please commit your changes before running this script.";
    echo "To reset all your changes, run this instead: git reset --hard HEAD"
    exit 1;
else
    echo "Git status is clean. Proceeding with the script.";
fi

# Run your commands

echo "Running: pnpm exec changeset version --snapshot $version"
pnpm exec changeset version --snapshot $version

echo "Running: pnpm run build --filter \"@trigger.dev/*\" --filter \"trigger.dev\""
pnpm run build --filter "@trigger.dev/*" --filter "trigger.dev"

echo "Going to run: pnpm exec changeset publish --no-git-tag --snapshot --tag $version"
read -p "Do you wish to continue? (y/N): " prompt
if [[ $prompt =~ [yY](es)* ]]; then
    pnpm exec changeset publish --no-git-tag --snapshot --tag $version
else
    echo "Publish command aborted by the user."
    git reset --hard HEAD
    exit 1;
fi

# If there were no errors, clear the git stage
echo "Commands ran successfully. Clearing the git stage."
git reset --hard HEAD

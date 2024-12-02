#!/bin/bash

set -e

# Function to extract GITHUB_TOKEN from .env file
extract_github_token() {
    if [ -f .env ]; then
        token=$(grep -E '^GITHUB_TOKEN=' .env | sed 's/^GITHUB_TOKEN=//' | sed 's/^"//' | sed 's/"$//')
        if [ ! -z "$token" ]; then
            export GITHUB_TOKEN="$token"
        else
            echo "GITHUB_TOKEN not found in .env file."
            return 1
        fi
    else
        echo "GITHUB_TOKEN not found in .env file."
        return 1
    fi
}

# Check if GITHUB_TOKEN is already set
if [[ -z "${GITHUB_TOKEN}" ]]; then
    extract_github_token || exit 1
fi

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
# Run changeset version command and capture its output
echo "Running: pnpm exec changeset version --snapshot $version"
if output=$(pnpm exec changeset version --snapshot $version 2>&1); then
    if echo "$output" | grep -q "No unreleased changesets found"; then
        echo "No unreleased changesets found. Exiting."
        exit 0
    fi
else
    echo "Error running changeset version command"
    exit 1
fi

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

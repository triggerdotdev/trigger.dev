#!/bin/bash

set -e  # Exit on error

echo "🚀 Installing Trigger.dev MCP Server..."

# Get the absolute path to the node binary
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    echo "❌ Error: Node.js not found in PATH"
    echo "Please ensure Node.js is installed and available in your PATH"
    exit 1
fi

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Construct the path to the CLI index.js file
CLI_PATH="$SCRIPT_DIR/dist/esm/index.js"

# Construct the path to the MCP log file
MCP_LOG_FILE="$SCRIPT_DIR/.mcp.log"

# Make sure the MCP log file exists
touch "$MCP_LOG_FILE"

# Check if the CLI file exists
if [ ! -f "$CLI_PATH" ]; then
    echo "❌ Error: CLI file not found at $CLI_PATH"
    echo "Make sure to build the CLI first with: pnpm run build"
    exit 1
fi

# Ensure the CLI is executable
chmod +x "$CLI_PATH"

echo "✅ Found Node.js at: $NODE_PATH"
echo "✅ Found CLI at: $CLI_PATH"

# Claude Code configuration
CLAUDE_CONFIG="$HOME/.claude.json"

echo "📁 Claude configuration file: $CLAUDE_CONFIG"

# Check if Claude config exists, create if it doesn't
if [ ! -f "$CLAUDE_CONFIG" ]; then
    echo "📝 Creating new Claude configuration file..."
    echo '{"mcpServers": {}}' > "$CLAUDE_CONFIG"
fi

# Use Node.js to manipulate the JSON
echo "🔧 Updating Claude configuration..."

node -e "
const fs = require('fs');
const path = require('path');

const configPath = '$CLAUDE_CONFIG';
const nodePath = '$NODE_PATH';
const cliPath = '$CLI_PATH';
const logFile = '$MCP_LOG_FILE';

try {
    // Read existing config
    let config;
    try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(configContent);
    } catch (error) {
        console.log('📝 Creating new configuration structure...');
        config = {};
    }

    // Ensure mcpServers object exists
    if (!config.mcpServers) {
        config.mcpServers = {};
    }

    // Add/update trigger.dev entry
    config.mcpServers['trigger'] = {
        command: nodePath,
        args: [cliPath, 'mcp', '--log-file', logFile, '--api-url', 'http://localhost:3030']
    };

    // Write back to file with proper formatting
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    console.log('✅ Successfully installed Trigger.dev MCP server to Claude Code');
    console.log('');
    console.log('📋 Configuration Details:');
    console.log('   • Config file:', configPath);
    console.log('   • Node.js path:', nodePath);
    console.log('   • CLI path:', cliPath);
    console.log('');
    console.log('🎉 Installation complete! You can now use Trigger.dev MCP commands in Claude Code.');
    console.log('💡 Try typing @ in Claude Code and select \"triggerdev\" to get started.');
    
} catch (error) {
    console.error('❌ Error updating Claude configuration:', error.message);
    process.exit(1);
}
"

echo ""
echo "🔍 You can test the MCP server with:"
echo "   pnpm run inspector"

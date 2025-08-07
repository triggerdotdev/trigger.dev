#!/bin/bash

set -e  # Exit on error

# Default target
TARGET="all"

# Parse command line arguments
show_help() {
    echo "🚀 Trigger.dev MCP Server Installer"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -t, --target TARGET    Install target: claude, cursor, or all (default: all)"
    echo "  -h, --help            Show this help message"
    echo ""
    echo "Targets:"
    echo "  claude    Install for Claude Code (~/.claude.json)"
    echo "  cursor    Install for Cursor (~/.cursor/mcp.json)"
    echo "  all       Install for all supported targets"
    echo ""
    echo "Examples:"
    echo "  $0                    # Install for all targets"
    echo "  $0 -t claude         # Install only for Claude Code"
    echo "  $0 -t cursor         # Install only for Cursor"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -t|--target)
            TARGET="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "❌ Unknown option: $1"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

# Validate target
case $TARGET in
    claude|cursor|all)
        ;;
    *)
        echo "❌ Invalid target: $TARGET"
        echo "Valid targets are: claude, cursor, all"
        exit 1
        ;;
esac

echo "🚀 Installing Trigger.dev MCP Server for target: $TARGET"

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

# Function to install for Claude Code
install_claude() {
    echo ""
    echo "🔧 Installing for Claude Code..."
    
    local CLAUDE_CONFIG="$HOME/.claude.json"
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
        console.log('📋 Claude Code Configuration:');
        console.log('   • Config file:', configPath);
        console.log('   • Node.js path:', nodePath);
        console.log('   • CLI path:', cliPath);
        console.log('');
        console.log('💡 Try typing @ in Claude Code and select \"triggerdev\" to get started.');
        
    } catch (error) {
        console.error('❌ Error updating Claude configuration:', error.message);
        process.exit(1);
    }
    "
}

# Function to install for Cursor
install_cursor() {
    echo ""
    echo "🔧 Installing for Cursor..."
    
    local CURSOR_DIR="$HOME/.cursor"
    local CURSOR_CONFIG="$CURSOR_DIR/mcp.json"
    
    echo "📁 Cursor configuration file: $CURSOR_CONFIG"

    # Create Cursor directory if it doesn't exist
    if [ ! -d "$CURSOR_DIR" ]; then
        echo "📝 Creating Cursor configuration directory..."
        mkdir -p "$CURSOR_DIR"
    fi

    # Check if Cursor config exists, create if it doesn't
    if [ ! -f "$CURSOR_CONFIG" ]; then
        echo "📝 Creating new Cursor configuration file..."
        echo '{"mcpServers": {}}' > "$CURSOR_CONFIG"
    fi

    # Use Node.js to manipulate the JSON
    echo "🔧 Updating Cursor configuration..."

    node -e "
    const fs = require('fs');
    const path = require('path');

    const configPath = '$CURSOR_CONFIG';
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
        
        console.log('✅ Successfully installed Trigger.dev MCP server to Cursor');
        console.log('');
        console.log('📋 Cursor Configuration:');
        console.log('   • Config file:', configPath);
        console.log('   • Node.js path:', nodePath);
        console.log('   • CLI path:', cliPath);
        console.log('');
        console.log('💡 You can now use Trigger.dev MCP commands in Cursor.');
        
    } catch (error) {
        console.error('❌ Error updating Cursor configuration:', error.message);
        process.exit(1);
    }
    "
}

# Install based on target
case $TARGET in
    claude)
        install_claude
        ;;
    cursor)
        install_cursor
        ;;
    all)
        install_claude
        install_cursor
        ;;
esac

echo ""
echo "🎉 Installation complete!"
echo ""
echo "🔍 You can test the MCP server with:"
echo "   pnpm run inspector"

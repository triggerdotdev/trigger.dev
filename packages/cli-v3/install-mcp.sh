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
    echo "  -t, --target TARGET    Install target: claude, claude-desktop, cursor, vscode, crush, windsurf, or all (default: all)"
    echo "  -h, --help            Show this help message"
    echo ""
    echo "Targets:"
    echo "  claude         Install for Claude Code (~/.claude.json)"
    echo "  claude-desktop Install for Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json)"
    echo "  cursor         Install for Cursor (~/.cursor/mcp.json)"
    echo "  vscode         Install for VS Code (~/Library/Application Support/Code/User/mcp.json)"
    echo "  crush          Install for Crush (~/.config/crush/crush.json)"
    echo "  windsurf       Install for Windsurf (~/.codeium/windsurf/mcp_config.json)"
    echo "  all            Install for all supported targets"
    echo ""
    echo "Examples:"
    echo "  $0                         # Install for all targets"
    echo "  $0 -t claude              # Install only for Claude Code"
    echo "  $0 -t claude-desktop      # Install only for Claude Desktop"
    echo "  $0 -t cursor              # Install only for Cursor"
    echo "  $0 -t vscode              # Install only for VS Code"
    echo "  $0 -t crush               # Install only for Crush"
    echo "  $0 -t windsurf            # Install only for Windsurf"
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
    claude|claude-desktop|cursor|vscode|crush|windsurf|all)
        ;;
    *)
        echo "❌ Invalid target: $TARGET"
        echo "Valid targets are: claude, claude-desktop, cursor, vscode, crush, windsurf, all"
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

# Function to install for Claude Desktop
install_claude_desktop() {
    echo ""
    echo "🔧 Installing for Claude Desktop..."
    
    local CLAUDE_DESKTOP_DIR="$HOME/Library/Application Support/Claude"
    local CLAUDE_DESKTOP_CONFIG="$CLAUDE_DESKTOP_DIR/claude_desktop_config.json"
    
    echo "📁 Claude Desktop configuration file: $CLAUDE_DESKTOP_CONFIG"

    # Create Claude Desktop directory if it doesn't exist
    if [ ! -d "$CLAUDE_DESKTOP_DIR" ]; then
        echo "📝 Creating Claude Desktop configuration directory..."
        mkdir -p "$CLAUDE_DESKTOP_DIR"
    fi

    # Check if Claude Desktop config exists, create if it doesn't
    if [ ! -f "$CLAUDE_DESKTOP_CONFIG" ]; then
        echo "📝 Creating new Claude Desktop configuration file..."
        echo '{"mcpServers": {}}' > "$CLAUDE_DESKTOP_CONFIG"
    fi

    # Use Node.js to manipulate the JSON
    echo "🔧 Updating Claude Desktop configuration..."

    node -e "
    const fs = require('fs');
    const path = require('path');

    const configPath = '$CLAUDE_DESKTOP_CONFIG';
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
        
        console.log('✅ Successfully installed Trigger.dev MCP server to Claude Desktop');
        console.log('');
        console.log('📋 Claude Desktop Configuration:');
        console.log('   • Config file:', configPath);
        console.log('   • Node.js path:', nodePath);
        console.log('   • CLI path:', cliPath);
        console.log('');
        console.log('💡 You can now use Trigger.dev MCP commands in Claude Desktop.');
        
    } catch (error) {
        console.error('❌ Error updating Claude Desktop configuration:', error.message);
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

# Function to install for VS Code
install_vscode() {
    echo ""
    echo "🔧 Installing for VS Code..."
    
    local VSCODE_DIR="$HOME/Library/Application Support/Code/User"
    local VSCODE_CONFIG="$VSCODE_DIR/mcp.json"
    
    echo "📁 VS Code configuration file: $VSCODE_CONFIG"

    # Create VS Code User directory if it doesn't exist
    if [ ! -d "$VSCODE_DIR" ]; then
        echo "📝 Creating VS Code User configuration directory..."
        mkdir -p "$VSCODE_DIR"
    fi

    # Check if VS Code config exists, create if it doesn't
    if [ ! -f "$VSCODE_CONFIG" ]; then
        echo "📝 Creating new VS Code configuration file..."
        echo '{"servers": {}}' > "$VSCODE_CONFIG"
    fi

    # Use Node.js to manipulate the JSON
    echo "🔧 Updating VS Code configuration..."

    node -e "
    const fs = require('fs');
    const path = require('path');

    const configPath = '$VSCODE_CONFIG';
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

        // Ensure servers object exists
        if (!config.servers) {
            config.servers = {};
        }

        // Add/update trigger.dev entry
        config.servers['trigger'] = {
            command: nodePath,
            args: [cliPath, 'mcp', '--log-file', logFile, '--api-url', 'http://localhost:3030']
        };

        // Write back to file with proper formatting
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        
        console.log('✅ Successfully installed Trigger.dev MCP server to VS Code');
        console.log('');
        console.log('📋 VS Code Configuration:');
        console.log('   • Config file:', configPath);
        console.log('   • Node.js path:', nodePath);
        console.log('   • CLI path:', cliPath);
        console.log('');
        console.log('💡 You can now use Trigger.dev MCP commands in VS Code.');
        
    } catch (error) {
        console.error('❌ Error updating VS Code configuration:', error.message);
        process.exit(1);
    }
    "
}

# Function to install for Crush
install_crush() {
    echo ""
    echo "🔧 Installing for Crush..."
    
    local CRUSH_DIR="$HOME/.config/crush"
    local CRUSH_CONFIG="$CRUSH_DIR/crush.json"
    
    echo "📁 Crush configuration file: $CRUSH_CONFIG"

    # Create Crush config directory if it doesn't exist
    if [ ! -d "$CRUSH_DIR" ]; then
        echo "📝 Creating Crush configuration directory..."
        mkdir -p "$CRUSH_DIR"
    fi

    # Check if Crush config exists, create if it doesn't
    if [ ! -f "$CRUSH_CONFIG" ]; then
        echo "📝 Creating new Crush configuration file..."
        echo '{"$schema": "https://charm.land/crush.json", "mcp": {}}' > "$CRUSH_CONFIG"
    fi

    # Use Node.js to manipulate the JSON
    echo "🔧 Updating Crush configuration..."

    node -e "
    const fs = require('fs');
    const path = require('path');

    const configPath = '$CRUSH_CONFIG';
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

        // Ensure schema and mcp object exists
        if (!config['\$schema']) {
            config['\$schema'] = 'https://charm.land/crush.json';
        }
        if (!config.mcp) {
            config.mcp = {};
        }

        // Add/update trigger.dev entry
        config.mcp['trigger'] = {
            type: 'stdio',
            command: nodePath,
            args: [cliPath, 'mcp', '--log-file', logFile, '--api-url', 'http://localhost:3030']
        };

        // Write back to file with proper formatting
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        
        console.log('✅ Successfully installed Trigger.dev MCP server to Crush');
        console.log('');
        console.log('📋 Crush Configuration:');
        console.log('   • Config file:', configPath);
        console.log('   • Node.js path:', nodePath);
        console.log('   • CLI path:', cliPath);
        console.log('');
        console.log('💡 You can now use Trigger.dev MCP commands in Crush.');
        
    } catch (error) {
        console.error('❌ Error updating Crush configuration:', error.message);
        process.exit(1);
    }
    "
}

# Function to install for Windsurf
install_windsurf() {
    echo ""
    echo "🔧 Installing for Windsurf..."
    
    local WINDSURF_DIR="$HOME/.codeium/windsurf"
    local WINDSURF_CONFIG="$WINDSURF_DIR/mcp_config.json"
    
    echo "📁 Windsurf configuration file: $WINDSURF_CONFIG"

    # Create Windsurf config directory if it doesn't exist
    if [ ! -d "$WINDSURF_DIR" ]; then
        echo "📝 Creating Windsurf configuration directory..."
        mkdir -p "$WINDSURF_DIR"
    fi

    # Check if Windsurf config exists, create if it doesn't
    if [ ! -f "$WINDSURF_CONFIG" ]; then
        echo "📝 Creating new Windsurf configuration file..."
        echo '{"mcpServers": {}}' > "$WINDSURF_CONFIG"
    fi

    # Use Node.js to manipulate the JSON
    echo "🔧 Updating Windsurf configuration..."

    node -e "
    const fs = require('fs');
    const path = require('path');

    const configPath = '$WINDSURF_CONFIG';
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
        
        console.log('✅ Successfully installed Trigger.dev MCP server to Windsurf');
        console.log('');
        console.log('📋 Windsurf Configuration:');
        console.log('   • Config file:', configPath);
        console.log('   • Node.js path:', nodePath);
        console.log('   • CLI path:', cliPath);
        console.log('');
        console.log('💡 You can now use Trigger.dev MCP commands in Windsurf.');
        
    } catch (error) {
        console.error('❌ Error updating Windsurf configuration:', error.message);
        process.exit(1);
    }
    "
}

# Install based on target
case $TARGET in
    claude)
        install_claude
        ;;
    claude-desktop)
        install_claude_desktop
        ;;
    cursor)
        install_cursor
        ;;
    vscode)
        install_vscode
        ;;
    crush)
        install_crush
        ;;
    windsurf)
        install_windsurf
        ;;
    all)
        install_claude
        install_claude_desktop
        install_cursor
        install_vscode
        install_crush
        install_windsurf
        ;;
esac

echo ""
echo "🎉 Installation complete!"
echo ""
echo "🔍 You can test the MCP server with:"
echo "   pnpm run inspector"

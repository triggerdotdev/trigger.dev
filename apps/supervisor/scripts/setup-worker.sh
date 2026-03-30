#!/usr/bin/env bash
#
# Trigger.dev Worker Setup Script
# 
# Automates worker group creation and configuration for
# self-hosted Trigger.dev instances.
#
# Usage: ./scripts/setup-worker.sh [OPTIONS]
# Run with --help for detailed information

set -euo pipefail

# =====================================
# Configuration & Defaults
# =====================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPERVISOR_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$SUPERVISOR_DIR/.env"

DEFAULT_API_URL="http://localhost:3030"
DRY_RUN=0
MAKE_DEFAULT=0
LIST_PROJECTS=0

WORKER_NAME=""
PAT=""
API_URL=""
PROJECT_REF=""
PROJECT_ID=""

REQUIRED_COMMANDS=("curl" "jq")

# =====================================
# Color Output
# =====================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

success() { echo -e "${GREEN}✅ $1${NC}"; }
error() { echo -e "${RED}❌ $1${NC}" >&2; }
warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
info() { echo -e "${BLUE}ℹ️  $1${NC}"; }

# =====================================
# Helper Functions
# =====================================

show_help() {
  cat << EOF
Trigger.dev Worker Setup Script

USAGE:
  ./scripts/setup-worker.sh [OPTIONS]

REQUIRED (if not in environment):
  --name <name>              Worker group name

OPTIONAL:
  --pat <token>              Personal Access Token (tr_pat_...)
  --api-url <url>            API URL (default: http://localhost:3030)
  --project-ref <ref>        Project external ref (proj_...)
  --project-id <id>          Project internal ID (cmk...)
  --default                  Make worker default for project

UTILITY:
  --list-projects            List all projects and exit
  --dry-run                  Show what would be done without executing
  --help, -h                 Show this help message

EXAMPLES:
  # Interactive mode
  ./scripts/setup-worker.sh

  # With all parameters
  ./scripts/setup-worker.sh \\
    --name my-worker \\
    --pat tr_pat_... \\
    --api-url https://trigger.example.com \\
    --project-ref proj_... \\
    --default

  # List projects first
  ./scripts/setup-worker.sh --list-projects

  # Dry-run mode
  ./scripts/setup-worker.sh --name test --dry-run

ENVIRONMENT VARIABLES:
  TRIGGER_PAT                Personal Access Token
  TRIGGER_API_URL            API URL
  TRIGGER_WORKER_NAME        Worker group name
  TRIGGER_PROJECT_REF        Project external ref
  TRIGGER_PROJECT_ID         Project internal ID

For more information, see apps/supervisor/README.md
EOF
}

check_dependencies() {
  for cmd in "${REQUIRED_COMMANDS[@]}"; do
    if ! command -v "$cmd" &> /dev/null; then
      error "Required command '$cmd' not found"
      echo ""
      echo "Install $cmd:"
      case "$cmd" in
        jq)
          echo "  - macOS:   brew install jq"
          echo "  - Linux:   apt-get install jq / yum install jq"
          echo "  - Windows: choco install jq"
          ;;
        curl)
          echo "  - macOS:   (built-in)"
          echo "  - Linux:   apt-get install curl"
          echo "  - Windows: (built-in in Windows 10+)"
          ;;
      esac
      exit 1
    fi
  done
}

load_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    info "Loading .env file..."
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --name)
        WORKER_NAME="$2"
        shift 2
        ;;
      --pat)
        PAT="$2"
        shift 2
        ;;
      --api-url)
        API_URL="$2"
        shift 2
        ;;
      --project-ref)
        PROJECT_REF="$2"
        shift 2
        ;;
      --project-id)
        PROJECT_ID="$2"
        shift 2
        ;;
      --default)
        MAKE_DEFAULT=1
        shift
        ;;
      --list-projects)
        LIST_PROJECTS=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --help|-h)
        show_help
        exit 0
        ;;
      *)
        error "Unknown option: $1"
        echo "Run with --help for usage information"
        exit 1
        ;;
    esac
  done
}

prompt_interactive() {
  # Prompt for PAT if missing
  if [[ -z "$PAT" ]]; then
    warning "PAT not found in environment or .env"
    echo ""
    echo "Please enter your Personal Access Token (PAT):"
    echo "  Format: tr_pat_..."
    echo "  Location: ~/.config/trigger/config.json or ~/Library/Preferences/trigger/config.json"
    read -r -p "PAT: " PAT
    echo ""
  fi

  # Prompt for API URL if missing
  if [[ -z "$API_URL" ]]; then
    read -r -p "Please enter the API URL [$DEFAULT_API_URL]: " API_URL
    API_URL="${API_URL:-$DEFAULT_API_URL}"
    echo ""
  fi

  # Prompt for worker name if missing
  if [[ -z "$WORKER_NAME" ]]; then
    read -r -p "Please enter the worker group name: " WORKER_NAME
    echo ""
  fi

  # Prompt for project association
  if [[ -z "$PROJECT_REF" ]] && [[ -z "$PROJECT_ID" ]]; then
    read -r -p "Make this worker default for a project? [y/N]: " associate_project
    if [[ "$associate_project" =~ ^[Yy]$ ]]; then
      MAKE_DEFAULT=1
      read -r -p "Please enter project ref (proj_...) or project ID (cmk...): " project_input
      if [[ "$project_input" =~ ^proj_ ]]; then
        PROJECT_REF="$project_input"
      elif [[ "$project_input" =~ ^cmk ]]; then
        PROJECT_ID="$project_input"
      fi
      echo ""
    fi
  fi
}

validate_pat() {
  if [[ ! "$PAT" =~ ^tr_pat_ ]]; then
    error "Invalid Personal Access Token format"
    echo ""
    echo "Expected: tr_pat_... (40 characters)"
    echo "Got:      $PAT"
    echo ""
    echo "PAT starts with 'tr_pat_', not 'tr_prod_' or 'tr_dev_'"
    echo ""
    echo "Find your PAT:"
    echo "  - macOS:  cat ~/Library/Preferences/trigger/config.json | jq -r '.profiles.default.accessToken'"
    echo "  - Linux:  cat ~/.config/trigger/config.json | jq -r '.profiles.default.accessToken'"
    exit 1
  fi

  if [[ ${#PAT} -ne 47 ]]; then
    error "Invalid PAT length (expected 47 characters: 'tr_pat_' + 40)"
    exit 1
  fi
}

validate_api_url() {
  if [[ ! "$API_URL" =~ ^https?:// ]]; then
    error "Invalid API URL format (must start with http:// or https://)"
    exit 1
  fi
}

test_api_connection() {
  info "Testing API connection..."
  
  local response
  local http_code
  local body
  
  response=$(curl -sS -w "\n%{http_code}" \
    -H "Authorization: Bearer $PAT" \
    "$API_URL/api/v1/projects" 2>&1)
  
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  
  if [[ "$http_code" != "200" ]]; then
    error "Failed to connect to API (HTTP $http_code)"
    echo ""
    echo "Response: $body"
    exit 1
  fi
  
  success "Connected to API successfully"
}

list_projects() {
  info "Fetching projects..."
  
  local response
  local project_count
  
  response=$(curl -sS \
    -H "Authorization: Bearer $PAT" \
    "$API_URL/api/v1/projects")
  
  project_count=$(echo "$response" | jq '. | length')
  
  if [[ "$project_count" -eq 0 ]]; then
    warning "No projects found"
    exit 0
  fi
  
  echo ""
  echo "Available Projects:"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  
  echo "$response" | jq -r '.[] | 
    "Project: \(.name)\n" +
    "  External Ref: \(.externalRef)\n" +
    "  Internal ID:  \(.id)\n" +
    "  Organization: \(.organization.title) (\(.organization.slug))\n" +
    "  Created:      \(.createdAt)\n"'
  
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "Use either ID type with --project-ref or --project-id"
}

resolve_project_id() {
  if [[ -n "$PROJECT_REF" ]]; then
    info "Resolving project ID..."
    
    local response
    local project_name
    
    response=$(curl -sS \
      -H "Authorization: Bearer $PAT" \
      "$API_URL/api/v1/projects")
    
    PROJECT_ID=$(echo "$response" | jq -r ".[] | select(.externalRef == \"$PROJECT_REF\") | .id")
    
    if [[ -z "$PROJECT_ID" ]]; then
      error "Project not found: $PROJECT_REF"
      exit 1
    fi
    
    project_name=$(echo "$response" | jq -r ".[] | select(.externalRef == \"$PROJECT_REF\") | .name")
    success "Project found: $project_name ($PROJECT_REF → $PROJECT_ID)"
  fi
}

create_worker() {
  local json_payload
  local make_default_bool
  
  # Convert 0/1 to false/true for JSON boolean
  if [[ $MAKE_DEFAULT -eq 1 ]]; then
    make_default_bool="true"
  else
    make_default_bool="false"
  fi
  
  json_payload=$(jq -n \
    --arg name "$WORKER_NAME" \
    --arg projectId "$PROJECT_ID" \
    --argjson makeDefault "$make_default_bool" \
    '{name: $name, projectId: ($projectId // null), makeDefaultForProject: $makeDefault}')
  
  if [[ $DRY_RUN -eq 1 ]]; then
    echo ""
    echo -e "${BOLD}[DRY-RUN] Would execute:${NC}"
    echo "curl -X POST \\"
    echo "  \"$API_URL/admin/api/v1/workers\" \\"
    echo "  -H \"Authorization: Bearer tr_pat_***...***\" \\"
    echo "  -H \"Content-Type: application/json\" \\"
    echo "  -d '$json_payload'"
    echo ""
    echo -e "${BOLD}[DRY-RUN] Expected outcome:${NC}"
    echo "  ✓ Create worker group \"$WORKER_NAME\""
    if [[ -n "$PROJECT_ID" ]]; then
      echo "  ✓ Associate with project ($PROJECT_REF)"
    fi
    if [[ $MAKE_DEFAULT -eq 1 ]]; then
      echo "  ✓ Set as default worker for project"
    fi
    echo ""
    return 0
  fi
  
  info "Creating worker group \"$WORKER_NAME\"..."
  
  local response
  
  response=$(curl -sS \
    -X POST \
    "$API_URL/admin/api/v1/workers" \
    -H "Authorization: Bearer $PAT" \
    -H "Content-Type: application/json" \
    -d "$json_payload")
  
  if echo "$response" | jq -e '.error' > /dev/null 2>&1; then
    error "Failed to create worker"
    echo ""
    echo "Error: $(echo "$response" | jq -r '.error')"
    exit 1
  fi
  
  success "Worker group created successfully"
  
  if [[ -n "$PROJECT_ID" ]]; then
    success "Worker associated with project"
  fi
  
  if [[ $MAKE_DEFAULT -eq 1 ]]; then
    success "Worker set as default for project"
  fi
  
  # Store response for display
  WORKER_RESPONSE="$response"
}

display_results() {
  local token
  token=$(echo "$WORKER_RESPONSE" | jq -r '.token.plaintext // empty')
  
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "🎉 Worker Setup Complete!"
  echo ""
  
  if [[ -n "$token" ]]; then
    echo "Worker Token:"
    echo "  $token"
  else
    warning "No token returned (worker group may already exist)"
    echo "  Use an existing token or create a new worker group with a different name"
  fi
  
  echo ""
  echo "📝 Next Steps:"
  echo ""
  
  if [[ -n "$token" ]]; then
    echo "1. Add the token to your .env file:"
    echo "   "
    echo "   echo 'TRIGGER_WORKER_TOKEN=$token' >> .env"
    echo ""
  fi
  
  echo "2. Start the supervisor:"
  echo "   "
  echo "   pnpm dev"
  echo ""
  echo "3. Deploy your project:"
  echo "   "
  echo "   pnpm exec trigger deploy --self-hosted"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}

# =====================================
# Main Function
# =====================================

main() {
  info "Loading configuration..."
  
  # 1. Check dependencies
  check_dependencies
  
  # 2. Load environment
  load_env_file
  
  # 3. Apply env vars
  PAT="${PAT:-${TRIGGER_PAT:-}}"
  API_URL="${API_URL:-${TRIGGER_API_URL:-$DEFAULT_API_URL}}"
  WORKER_NAME="${WORKER_NAME:-${TRIGGER_WORKER_NAME:-}}"
  PROJECT_REF="${PROJECT_REF:-${TRIGGER_PROJECT_REF:-}}"
  PROJECT_ID="${PROJECT_ID:-${TRIGGER_PROJECT_ID:-}}"
  
  # 4. Parse CLI arguments (overrides env)
  parse_arguments "$@"
  
  # 5. Interactive prompts for missing values (only if values are actually missing)
  if [[ $LIST_PROJECTS -eq 0 ]] && [[ ( -z "$PAT" || -z "$API_URL" || -z "$WORKER_NAME" ) ]]; then
    prompt_interactive
  fi
  
  # 6. Validate inputs
  validate_pat
  validate_api_url
  
  # 7. Test connection
  test_api_connection
  
  # 8. List projects if requested
  if [[ $LIST_PROJECTS -eq 1 ]]; then
    list_projects
    exit 0
  fi
  
  # 9. Validate worker name
  if [[ -z "$WORKER_NAME" ]]; then
    error "Worker name is required"
    echo "Run with --help for usage information"
    exit 1
  fi
  
  # 10. Resolve project ID
  if [[ -n "$PROJECT_REF" ]]; then
    resolve_project_id
  fi
  
  # 11. Create worker
  create_worker
  
  # 12. Display results
  if [[ $DRY_RUN -eq 0 ]]; then
    display_results
  fi
}

# =====================================
# Execute
# =====================================

main "$@"

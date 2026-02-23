#!/bin/bash
# =============================================================================
# LASO Search - Development Server Start Script
# This script injects the API key and starts a local development server
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# First, ensure API key is set up
if [ ! -f ".env" ]; then
    print_status "API key not configured. Running setup..."
    ./get-api-key.sh
fi

# Source the environment variables
export $(cat .env | xargs)

# Check for required files
if [ ! -f "index.template.html" ]; then
    print_error "index.template.html not found"
    exit 1
fi

# Inject API key
print_status "Injecting API key..."
node inject-api-key.js

# Start Python HTTP server
print_status "Starting development server on http://localhost:8081..."
print_success "Open your browser to http://localhost:8081"
print_status "Press Ctrl+C to stop the server"

python3 -m http.server 8080

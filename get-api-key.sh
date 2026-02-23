#!/bin/bash
# =============================================================================
# LASO Search - Start Development Server
# NO API KEY REQUIRED - Uses OpenStreetMap (completely free)
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_status "LASO Search - Starting development server"
print_status "Using OpenStreetMap - NO API KEY REQUIRED"

# Create index.html from template (no API key injection needed)
print_status "Generating index.html from template..."

node -e "
const fs = require('fs');
const path = require('path');

const templatePath = path.join(__dirname, 'index.template.html');
const outputPath = path.join(__dirname, 'index.html');

if (!fs.existsSync(templatePath)) {
    console.error('Error: index.template.html not found');
    process.exit(1);
}

let html = fs.readFileSync(templatePath, 'utf8');
fs.writeFileSync(outputPath, html);
console.log('index.html generated successfully');
"

print_success "index.html generated"

# Start Python HTTP server
print_status "Starting development server on http://localhost:8080"
print_status "Press Ctrl+C to stop"

python3 -m http.server 8080 2>/dev/null || python -m http.server 8080

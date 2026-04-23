#!/bin/bash
#============================================================
#  NEST PPPoE Manager - Infrastructure Installation Script
#  Installs 3proxy (from source) and PPPoE dependencies
#============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_step() {
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  ▸ $1${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

print_ok() { echo -e "${GREEN}  ✔ $1${NC}"; }
print_warn() { echo -e "${YELLOW}  ⚠ $1${NC}"; }
print_err() { echo -e "${RED}  ✖ $1${NC}"; }

# Must run as root
if [ "$EUID" -ne 0 ]; then
    print_err "Please run as root: sudo ./install-infra.sh"
    exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. Update and install basic build tools
print_step "Updating system and installing build tools"
apt-get update -y
apt-get install -y git build-essential gcc make

# 2. Install PPPoE dependencies via apt
print_step "Installing pppoe and pppoeconf via apt"
apt-get install -y ppp pppoe pppoeconf
print_ok "PPPoE dependencies installed"

# 3. Install 3proxy via source compilation
print_step "Installing 3proxy from source"
if command -v 3proxy &>/dev/null; then
    print_warn "3proxy is already installed"
else
    TEMP_DIR=$(mktemp -d)
    print_ok "Created temp directory: $TEMP_DIR"
    
    cd "$TEMP_DIR"
    git clone https://github.com/3proxy/3proxy.git
    cd 3proxy
    
    print_step "Building 3proxy..."
    ln -sf Makefile.Linux Makefile
    make -f Makefile.Linux
    
    print_step "Installing 3proxy..."
    make -f Makefile.Linux install
    
    cd "$PROJECT_DIR"
    rm -rf "$TEMP_DIR"
    print_ok "3proxy built and installed successfully"
fi

# Final Verification
print_step "Verification"
check_bin() {
    if command -v $1 &>/dev/null; then
        print_ok "$1 found at $(which $1)"
    else
        print_err "$1 NOT FOUND"
    fi
}

check_bin "3proxy"
check_bin "pppoe"
check_bin "pppoeconf"

echo -e "\n${GREEN}Infrastructure installation complete!${NC}\n"

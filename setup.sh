#!/bin/bash
#============================================================
#  NEST PPPoE Manager - Full Setup Script
#  Run once on a fresh Ubuntu/Debian system
#  Usage: chmod +x setup.sh && ./setup.sh
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

print_ok() {
    echo -e "${GREEN}  ✔ $1${NC}"
}

print_warn() {
    echo -e "${YELLOW}  ⚠ $1${NC}"
}

print_err() {
    echo -e "${RED}  ✖ $1${NC}"
}

# Must run as root
if [ "$EUID" -ne 0 ]; then
    print_err "Please run as root: sudo ./setup.sh"
    exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}       ${GREEN}🚀 NEST PPPoE Manager - Setup Script${NC}                  ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}       ${YELLOW}Installing all dependencies from scratch${NC}              ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"

#============================================================
# 1. System Update
#============================================================
print_step "Updating system packages"
apt-get update -y
apt-get upgrade -y
print_ok "System updated"

#============================================================
# 2. Essential Build Tools & Utilities
#============================================================
print_step "Installing essential build tools & utilities"
apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    gcc \
    g++ \
    make \
    cmake \
    python3 \
    python3-pip \
    software-properties-common \
    ca-certificates \
    gnupg \
    lsb-release \
    unzip \
    htop \
    nano \
    vim
print_ok "Build tools installed"

#============================================================
# 3. Network & Process Tools
#============================================================
print_step "Installing network & process tools"
apt-get install -y \
    net-tools \
    iproute2 \
    iputils-ping \
    dnsutils \
    lsof \
    iptables \
    traceroute \
    tcpdump \
    nmap \
    procps \
    coreutils \
    bash \
    kmod
# iproute2: ip, ss commands (macvlan, routing, port check)
# lsof: find process by port (pppoe.js)
# procps: pgrep, pkill, top (status.js, routes.js)
# coreutils: df (disk usage in status.js)
# bash: web terminal (node-pty spawns bash)
# kmod: kernel module management
print_ok "Network & process tools installed"

#============================================================
# 4. PPPoE Client (pppd + pppoe)
#============================================================
print_step "Installing PPPoE client (pppd, pppoe)"
apt-get install -y \
    ppp \
    pppoe \
    pppoeconf
print_ok "PPPoE client installed"

#============================================================
# 5. 3proxy (Proxy Server)
#============================================================
print_step "Installing 3proxy"
if command -v 3proxy &>/dev/null; then
    print_warn "3proxy already installed: $(3proxy --version 2>&1 | head -1 || echo 'found')"
else
    # Try apt first
    if apt-get install -y 3proxy 2>/dev/null; then
        print_ok "3proxy installed via apt"
    else
        # Build from source
        print_warn "Building 3proxy from source..."
        TEMP_DIR=$(mktemp -d)
        cd "$TEMP_DIR"
        git clone https://github.com/3proxy/3proxy.git
        cd 3proxy
        ln -sf Makefile.Linux Makefile
        make -f Makefile.Linux
        make -f Makefile.Linux install
        cd "$PROJECT_DIR"
        rm -rf "$TEMP_DIR"
        print_ok "3proxy built and installed from source"
    fi
fi

# Verify 3proxy
if command -v 3proxy &>/dev/null; then
    print_ok "3proxy is available"
else
    print_warn "3proxy may need manual PATH configuration"
fi

#============================================================
# 6. Node.js 20 LTS
#============================================================
print_step "Installing Node.js 20 LTS"
if command -v node &>/dev/null; then
    CURRENT_NODE=$(node -v)
    print_warn "Node.js already installed: $CURRENT_NODE"
fi

# Install via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Verify
NODE_VER=$(node -v)
NPM_VER=$(npm -v)
print_ok "Node.js $NODE_VER installed"
print_ok "npm $NPM_VER installed"

#============================================================
# 7. PM2 (Process Manager) - Global
#============================================================
print_step "Installing PM2 globally"
npm install -g pm2
PM2_VER=$(pm2 -v)
print_ok "PM2 $PM2_VER installed"

#============================================================
# 8. Project Dependencies (npm install)
#============================================================
print_step "Installing project dependencies"
cd "$PROJECT_DIR"

# node-pty needs build tools (already installed above)
npm install
print_ok "npm dependencies installed"

#============================================================
# 9. Create necessary directories
#============================================================
print_step "Creating project directories"
mkdir -p "$PROJECT_DIR/logs"
mkdir -p "$PROJECT_DIR/proxy"
print_ok "Directories created"

#============================================================
# 10. Create necessary files if missing
#============================================================
print_step "Ensuring required files exist"
touch "$PROJECT_DIR/IP.txt"
touch "$PROJECT_DIR/blacklist.txt"
touch "$PROJECT_DIR/proxies.txt"

if [ ! -f "$PROJECT_DIR/config.json" ]; then
    cat > "$PROJECT_DIR/config.json" << 'CONFIGEOF'
{
    "device_code": "DEVICE_001",
    "pppoe": [
        {
            "username": "your_pppoe_username",
            "password": "your_pppoe_password",
            "max_session": 1,
            "interface": "eth0"
        }
    ]
}
CONFIGEOF
    print_warn "config.json created with default values - PLEASE EDIT IT!"
else
    print_ok "config.json already exists"
fi
print_ok "Required files ensured"

#============================================================
# 11. Set Permissions
#============================================================
print_step "Setting permissions"
chmod +x "$PROJECT_DIR/setup.sh" 2>/dev/null || true
chmod +x "$PROJECT_DIR/start.sh" 2>/dev/null || true
print_ok "Permissions set"

#============================================================
# 12. Setup PM2 Startup (auto-start on boot)
#============================================================
print_step "Configuring PM2 startup"
pm2 startup systemd -u root --hp /root 2>/dev/null || pm2 startup || true
print_ok "PM2 startup configured"

#============================================================
# 13. Configure System Limits (for high PPPoE session count)
#============================================================
print_step "Configuring system limits"

# Increase max open files
if ! grep -q "# NEST PPPoE Limits" /etc/security/limits.conf 2>/dev/null; then
    cat >> /etc/security/limits.conf << 'LIMITSEOF'

# NEST PPPoE Limits
* soft nofile 65535
* hard nofile 65535
root soft nofile 65535
root hard nofile 65535
LIMITSEOF
    print_ok "File descriptor limits increased"
else
    print_warn "Limits already configured"
fi

# Enable IP forwarding
if ! grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf 2>/dev/null; then
    echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
    sysctl -p 2>/dev/null || true
    print_ok "IP forwarding enabled"
else
    print_warn "IP forwarding already enabled"
fi

#============================================================
# Done!
#============================================================
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}       ${GREEN}✅ SETUP COMPLETE!${NC}                                     ${CYAN}║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  Node.js : $(node -v 2>/dev/null || echo 'N/A')                                           ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  npm     : $(npm -v 2>/dev/null || echo 'N/A')                                            ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  PM2     : $(pm2 -v 2>/dev/null || echo 'N/A')                                            ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  3proxy  : $(command -v 3proxy &>/dev/null && echo 'installed' || echo 'check manually')                                       ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  pppd    : $(command -v pppd &>/dev/null && echo 'installed' || echo 'check manually')                                       ${CYAN}║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}                                                              ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${YELLOW}Next steps:${NC}                                                ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  1. Edit config.json with your PPPoE credentials              ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  2. Run ${GREEN}./start.sh${NC} to start the application                   ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}                                                              ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

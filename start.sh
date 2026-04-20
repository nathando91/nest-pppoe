#!/bin/bash
#============================================================
#  NEST PPPoE Manager - Start Script
#  Start/Restart the application with PM2
#  Usage: ./start.sh
#============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="nest-pppoe"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}       ${GREEN}🚀 NEST PPPoE Manager - Starting...${NC}                   ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"

# Check if pm2 is installed
if ! command -v pm2 &>/dev/null; then
    echo -e "${RED}  ✖ PM2 is not installed. Run ./setup.sh first.${NC}"
    exit 1
fi

# Check if node is installed
if ! command -v node &>/dev/null; then
    echo -e "${RED}  ✖ Node.js is not installed. Run ./setup.sh first.${NC}"
    exit 1
fi

#============================================================
# Stop existing instance (if running)
#============================================================
echo -e "${YELLOW}  ▸ Stopping existing instance...${NC}"
pm2 stop "$APP_NAME" 2>/dev/null || true
pm2 delete "$APP_NAME" 2>/dev/null || true

#============================================================
# Start with PM2
#============================================================
echo -e "${GREEN}  ▸ Starting $APP_NAME with PM2...${NC}"
cd "$PROJECT_DIR"

pm2 start server.js \
    --name "$APP_NAME" \
    --cwd "$PROJECT_DIR" \
    --time \
    --restart-delay 3000 \
    --max-restarts 50 \
    --exp-backoff-restart-delay 1000

#============================================================
# Save PM2 process list
#============================================================
echo -e "${GREEN}  ▸ Saving PM2 process list...${NC}"
pm2 save

#============================================================
# Setup PM2 startup (auto-start on boot)
#============================================================
echo -e "${GREEN}  ▸ Configuring PM2 startup...${NC}"
pm2 startup systemd -u root --hp /root 2>/dev/null || pm2 startup 2>/dev/null || true
pm2 save

#============================================================
# Show status
#============================================================
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
pm2 status
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Get LAN IP for display
LAN_IP=$(ip -4 addr show | grep -oP 'inet \K192\.168\.[\d.]+' | head -1 2>/dev/null || echo "N/A")

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}       ${GREEN}✅ NEST PPPoE Manager is RUNNING!${NC}                      ${CYAN}║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}                                                              ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}Local:${NC}  http://localhost:3000                                ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}LAN:${NC}    http://$LAN_IP:3000                          ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}                                                              ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${YELLOW}PM2 Commands:${NC}                                              ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}    pm2 logs $APP_NAME     ${CYAN}-${NC} View logs                          ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}    pm2 restart $APP_NAME  ${CYAN}-${NC} Restart app                        ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}    pm2 stop $APP_NAME     ${CYAN}-${NC} Stop app                           ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}    pm2 monit              ${CYAN}-${NC} Monitor dashboard                  ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}                                                              ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}✔ Auto-restart on crash: YES${NC}                                ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}✔ Auto-start on reboot: YES${NC}                                 ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}✔ Process list saved: YES${NC}                                   ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}                                                              ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

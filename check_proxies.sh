#!/bin/bash
#
# check_proxies.sh - Kiểm tra liên tục TCP connect đến tất cả 3proxy
#
PROXIES_FILE="/root/nest/proxies.txt"
INTERVAL=10  # giây giữa mỗi vòng check
TIMEOUT=3    # timeout TCP connect (giây)
HOST="192.168.1.50"  # địa chỉ LAN để connect proxy

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
BOLD='\033[1m'

round=0
while true; do
    round=$((round + 1))
    TS=$(date '+%H:%M:%S')
    
    ALIVE=0
    DEAD=0
    DEAD_LIST=""
    TOTAL=0

    while IFS=: read -r IP PORT; do
        [ -z "$PORT" ] && continue
        TOTAL=$((TOTAL + 1))

        # TCP connect test
        if timeout "$TIMEOUT" bash -c "echo >/dev/tcp/${HOST}/${PORT}" </dev/null 2>/dev/null; then
            ALIVE=$((ALIVE + 1))
        else
            DEAD=$((DEAD + 1))
            DEAD_LIST="${DEAD_LIST}  ${RED}✗${NC} ${IP}:${PORT}\n"
        fi
    done < "$PROXIES_FILE"

    # Output
    echo ""
    echo -e "${BOLD}══════════════════════════════════════════${NC}"
    echo -e "${BOLD}  Proxy Health Check  │  Round #${round}  │  ${TS}${NC}"
    echo -e "${BOLD}══════════════════════════════════════════${NC}"
    echo ""

    if [ "$DEAD" -eq 0 ]; then
        echo -e "  ${GREEN}✓ ALL ${ALIVE}/${TOTAL} PROXIES ALIVE${NC}"
    else
        echo -e "  ${GREEN}✓ Alive: ${ALIVE}/${TOTAL}${NC}    ${RED}✗ Dead: ${DEAD}/${TOTAL}${NC}"
        echo ""
        echo -e "  ${YELLOW}Dead proxies:${NC}"
        echo -e "$DEAD_LIST"
    fi

    echo ""
    echo -e "  Checking every ${INTERVAL}s  │  Ctrl+C to stop"
    echo -e "${BOLD}══════════════════════════════════════════${NC}"

    sleep "$INTERVAL"
done

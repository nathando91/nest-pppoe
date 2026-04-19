#!/bin/bash
#
# rotate_all.sh - Xoay IP tất cả phiên PPPoE liên tục
# Usage: bash rotate_all.sh [interval_seconds]
#        bash rotate_all.sh --stats
#
# Log: /root/nest/logs/rotate_all.log (JSON)

NUM=30
INTERVAL=${1:-10}
LOG_FILE="/root/nest/logs/rotate_all.log"
ROTATE_TIMEOUT=45  # timeout mỗi session (giây)

mkdir -p "$(dirname "$LOG_FILE")"

# ========== CHẾ ĐỘ XEM THỐNG KÊ ==========
if [ "$1" = "--stats" ]; then
    if [ ! -f "$LOG_FILE" ]; then
        echo "❌ Chưa có log: $LOG_FILE"
        exit 1
    fi

    TOTAL=$(wc -l < "$LOG_FILE")
    SUCCESS=$(grep -c '"result":"changed"' "$LOG_FILE" 2>/dev/null || echo 0)
    SAME=$(grep -c '"result":"same_ip"' "$LOG_FILE" 2>/dev/null || echo 0)
    RECOVERED=$(grep -c '"result":"recovered"' "$LOG_FILE" 2>/dev/null || echo 0)
    FAILED=$(grep -c '"result":"failed"' "$LOG_FILE" 2>/dev/null || echo 0)

    echo "============================================"
    echo "  ROTATE THỐNG KÊ"
    echo "============================================"
    echo ""
    printf "  Tổng rotate:     %d\n" "$TOTAL"
    if [ "$TOTAL" -gt 0 ]; then
        printf "  ✅ Đổi IP:        %d (%.1f%%)\n" "$SUCCESS" "$(echo "scale=1; $SUCCESS * 100 / $TOTAL" | bc)"
        printf "  🔄 Khôi phục:     %d (%.1f%%)\n" "$RECOVERED" "$(echo "scale=1; $RECOVERED * 100 / $TOTAL" | bc)"
        printf "  ⚠️  IP không đổi:  %d (%.1f%%)\n" "$SAME" "$(echo "scale=1; $SAME * 100 / $TOTAL" | bc)"
        printf "  ❌ Lỗi:           %d (%.1f%%)\n" "$FAILED" "$(echo "scale=1; $FAILED * 100 / $TOTAL" | bc)"
    fi
    echo ""

    # Top 5 phiên bị lỗi nhiều nhất
    echo "  --- Phiên lỗi nhiều nhất ---"
    grep -E '"result":"(same_ip|failed)"' "$LOG_FILE" 2>/dev/null \
        | grep -oP '"ppp":"ppp\d+"' \
        | sort | uniq -c | sort -rn | head -5 \
        | while read count ppp; do
            NAME=$(echo "$ppp" | grep -oP 'ppp\d+')
            printf "  %-8s: %d lần\n" "$NAME" "$count"
        done
    echo ""

    # 10 dòng cuối
    echo "  --- 10 lần rotate gần nhất ---"
    tail -10 "$LOG_FILE" | while IFS= read -r line; do
        TS=$(echo "$line" | grep -oP '"time":"\K[^"]+')
        PPP=$(echo "$line" | grep -oP '"ppp":"\K[^"]+')
        RESULT=$(echo "$line" | grep -oP '"result":"\K[^"]+')
        OLD=$(echo "$line" | grep -oP '"old_ip":"\K[^"]+')
        NEW=$(echo "$line" | grep -oP '"new_ip":"\K[^"]+')
        case $RESULT in
            changed)   ICON="✅" ;;
            recovered) ICON="🔄" ;;
            same_ip)   ICON="⚠️ " ;;
            failed)    ICON="❌" ;;
            *)         ICON="?" ;;
        esac
        printf "  %s %s %-6s %-16s → %s\n" "$ICON" "$TS" "$PPP" "${OLD:--}" "${NEW:--}"
    done
    echo ""
    echo "============================================"
    exit 0
fi

# ========== CHẾ ĐỘ CHẠY ROTATE ==========

ROUND=0

echo "============================================"
echo "  ROTATE ALL - ${NUM} phiên PPPoE"
echo "  Interval: ${INTERVAL}s | Timeout: ${ROTATE_TIMEOUT}s/session"
echo "  Log: $LOG_FILE"
echo "  Stats: bash rotate_all.sh --stats"
echo "  Ctrl+C để dừng"
echo "============================================"
echo ""

while true; do
    ROUND=$((ROUND + 1))
    TS_START=$(date '+%H:%M:%S')

    R_SUCCESS=0
    R_SAME=0
    R_RECOVERED=0
    R_FAILED=0

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Vòng #${ROUND}  │  ${TS_START}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    for i in $(seq 0 $((NUM-1))); do
        IFACE="ppp${i}"
        TS=$(date '+%Y-%m-%d %H:%M:%S')

        # Lấy IP trước rotate
        OLD_IP=$(ip -4 addr show "$IFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+' || echo "")

        # Chạy rotate với timeout (--fast + disown pppd)
        timeout "$ROTATE_TIMEOUT" bash /root/nest/rotate_ip.sh "$i" --fast >/dev/null 2>&1
        EXIT_CODE=$?

        # Lấy IP sau rotate
        NEW_IP=$(ip -4 addr show "$IFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+' || echo "")

        # Xác định kết quả
        if [ $EXIT_CODE -ne 0 ] || [ -z "$NEW_IP" ]; then
            RESULT="failed"
            R_FAILED=$((R_FAILED + 1))
            ICON="❌"
        elif [ -z "$OLD_IP" ]; then
            RESULT="recovered"
            R_RECOVERED=$((R_RECOVERED + 1))
            ICON="🔄"
        elif [ "$NEW_IP" != "$OLD_IP" ]; then
            RESULT="changed"
            R_SUCCESS=$((R_SUCCESS + 1))
            ICON="✅"
        else
            RESULT="same_ip"
            R_SAME=$((R_SAME + 1))
            ICON="⚠️ "
        fi

        # Log JSON
        echo "{\"time\":\"${TS}\",\"round\":${ROUND},\"ppp\":\"${IFACE}\",\"old_ip\":\"${OLD_IP}\",\"new_ip\":\"${NEW_IP}\",\"result\":\"${RESULT}\"}" >> "$LOG_FILE"

        # Hiển thị 1 dòng
        printf "  %s %-6s %-16s → %-16s\n" "$ICON" "$IFACE" "${OLD_IP:-dead}" "${NEW_IP:-dead}"
    done

    # Tổng kết vòng
    TS_END=$(date '+%H:%M:%S')
    TOTAL=$((R_SUCCESS + R_SAME + R_RECOVERED + R_FAILED))
    echo ""
    echo "  Vòng #${ROUND} (${TS_START}→${TS_END}): ✅${R_SUCCESS} ⚠️${R_SAME} 🔄${R_RECOVERED} ❌${R_FAILED} / ${TOTAL}"
    echo "  Tiếp tục sau ${INTERVAL}s... (Ctrl+C dừng)"
    echo ""

    sleep "$INTERVAL"
done

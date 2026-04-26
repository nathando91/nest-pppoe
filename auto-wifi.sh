#!/bin/bash

# Script tự động cấu hình WiFi NEST ưu tiên hơn LAN
# Tác giả: Antigravity

echo "--- Đang bắt đầu cấu hình WiFi tự động ---"

# 1. Cài đặt wpasupplicant nếu chưa có
if ! command -v wpa_supplicant &> /dev/null; then
    echo "[1/4] Đang cài đặt wpasupplicant..."
    apt-get update && apt-get install -y wpasupplicant
else
    echo "[1/4] wpasupplicant đã được cài đặt."
fi

# 2. Tìm tên giao diện WiFi (thường bắt đầu bằng wl)
WIFI_IFACE=$(ls /sys/class/net | grep ^wl | head -n 1)

if [ -z "$WIFI_IFACE" ]; then
    echo "LỖI: Không tìm thấy card WiFi nào (tên bắt đầu bằng 'wl')."
    exit 1
fi

echo "[2/4] Đã tìm thấy card WiFi: $WIFI_IFACE"

# 3. Tạo file cấu hình Netplan
echo "[3/4] Đang tạo cấu hình Netplan tại /etc/netplan/60-wifi-config.yaml..."
cat <<EOF > /etc/netplan/60-wifi-config.yaml
network:
  version: 2
  wifis:
    $WIFI_IFACE:
      optional: true
      dhcp4: true
      access-points:
        "NEST":
          password: "01012026"
      dhcp4-overrides:
        route-metric: 50
EOF

# Phân quyền bảo mật cho file chứa mật khẩu
chmod 600 /etc/netplan/60-wifi-config.yaml

# 4. Áp dụng cấu hình
echo "[4/4] Đang áp dụng cấu hình mạng..."
netplan apply

echo "------------------------------------------"
echo "HOÀN TẤT! Máy sẽ tự động kết nối WiFi 'NEST'."
echo "WiFi hiện đang được ưu tiên hơn LAN (Metric 50)."
echo "------------------------------------------"

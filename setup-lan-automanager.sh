#!/bin/bash

# Script to automatically setup LAN Auto-Manager
# Detects and activates all ethernet interfaces automatically

# Check for root privileges
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root"
   exit 1
fi

echo "--- Installing LAN Auto-Manager ---"

# 1. Create systemd-networkd wildcard configuration
echo "Creating network configuration..."
cat <<EOF > /etc/systemd/network/99-wildcard-ethernet.network
[Match]
Type=ether

[Network]
DHCP=yes
KeepConfiguration=yes
IPv6AcceptRA=yes

[DHCP]
RouteMetric=100
UseMTU=yes
EOF

# 2. Create the hotplug script
echo "Creating hotplug script..."
cat <<EOF > /usr/local/bin/lan-hotplug.sh
#!/bin/bash
echo "Starting LAN Hotplug Monitor..."
while true; do
    INTERFACES=\$(ip -o link show | awk -F': ' '{print \$2}' | grep -E '^(en|eth)')
    for IFACE in \$INTERFACES; do
        STATUS=\$(cat /sys/class/net/\$IFACE/operstate 2>/dev/null)
        if [ "\$STATUS" == "down" ]; then
            echo "[\$(date)] Interface \$IFACE is DOWN. Bringing it UP..."
            ip link set "\$IFACE" up
        fi
    done
    sleep 10
done
EOF

# 3. Set permissions
chmod +x /usr/local/bin/lan-hotplug.sh

# 4. Create the systemd service
echo "Creating systemd service..."
cat <<EOF > /etc/systemd/system/lan-hotplug.service
[Unit]
Description=Continuous LAN Hotplug and Activation Service
After=network.target

[Service]
ExecStart=/usr/local/bin/lan-hotplug.sh
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# 5. Reload and start services
echo "Activating services..."
systemctl daemon-reload
systemctl enable lan-hotplug.service
systemctl start lan-hotplug.service
systemctl restart systemd-networkd

echo "--- Installation Complete! ---"
echo "Your system will now automatically detect and activate LAN cards every 10 seconds."
echo "Check logs with: journalctl -u lan-hotplug -f"

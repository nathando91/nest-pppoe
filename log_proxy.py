#!/usr/bin/env python3
"""
log_proxy.py - HTTP/HTTPS Proxy với logging đầy đủ (URL, headers, body)
Usage: python3 log_proxy.py --port 8081 --bind-ip 1.2.3.4 --log /root/nest/logs/proxy_ppp0.log
"""
import socket
import threading
import select
import argparse
import json
import os
import sys
from datetime import datetime
from urllib.parse import urlparse

BUFFER_SIZE = 65536
MAX_BODY_LOG = 2048  # Log tối đa 2KB body


class ProxyLogger:
    def __init__(self, log_file):
        self.log_file = log_file
        self.lock = threading.Lock()
        os.makedirs(os.path.dirname(log_file), exist_ok=True)

    def log(self, entry: dict):
        entry["timestamp"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        line = json.dumps(entry, ensure_ascii=False, default=str)
        with self.lock:
            with open(self.log_file, "a") as f:
                f.write(line + "\n")
            # Cũng print ra stdout để debug
            print(f"[{entry['timestamp']}] {entry.get('method', '')} {entry.get('url', '')}", flush=True)


def parse_request(data: bytes):
    """Parse HTTP request, trả về method, url, headers, body"""
    try:
        if b"\r\n\r\n" in data:
            head, body = data.split(b"\r\n\r\n", 1)
        else:
            head = data
            body = b""

        lines = head.decode("utf-8", errors="replace").split("\r\n")
        request_line = lines[0]
        parts = request_line.split(" ", 2)
        method = parts[0] if len(parts) >= 1 else ""
        url = parts[1] if len(parts) >= 2 else ""
        version = parts[2] if len(parts) >= 3 else ""

        headers = {}
        for line in lines[1:]:
            if ":" in line:
                key, val = line.split(":", 1)
                headers[key.strip()] = val.strip()

        return method, url, version, headers, body
    except Exception:
        return "", "", "", {}, b""


def handle_connect(client_sock, remote_host, remote_port, bind_ip, logger, client_addr):
    """Xử lý HTTPS CONNECT tunnel"""
    try:
        remote_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if bind_ip:
            remote_sock.bind((bind_ip, 0))
        remote_sock.settimeout(30)
        remote_sock.connect((remote_host, remote_port))

        # Trả 200 cho client
        client_sock.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")

        logger.log({
            "type": "CONNECT",
            "method": "CONNECT",
            "url": f"{remote_host}:{remote_port}",
            "client": f"{client_addr[0]}:{client_addr[1]}",
            "status": "tunnel_established"
        })

        # Tunnel 2 chiều
        sockets = [client_sock, remote_sock]
        while True:
            readable, _, errors = select.select(sockets, [], sockets, 60)
            if errors:
                break
            if not readable:
                break
            for sock in readable:
                data = sock.recv(BUFFER_SIZE)
                if not data:
                    return
                if sock is client_sock:
                    remote_sock.sendall(data)
                else:
                    client_sock.sendall(data)
    except Exception as e:
        logger.log({
            "type": "CONNECT_ERROR",
            "url": f"{remote_host}:{remote_port}",
            "error": str(e)
        })
    finally:
        remote_sock.close()


def handle_http(client_sock, method, url, version, headers, body, bind_ip, logger, client_addr):
    """Xử lý HTTP request (không phải CONNECT)"""
    remote_sock = None
    try:
        parsed = urlparse(url)
        host = parsed.hostname or headers.get("Host", "")
        port = parsed.port or 80
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        # Đọc thêm body nếu có Content-Length mà chưa nhận đủ
        content_length = int(headers.get("Content-Length", 0))
        while len(body) < content_length:
            try:
                more = client_sock.recv(BUFFER_SIZE)
                if not more:
                    break
                body += more
            except socket.timeout:
                break

        # Log request NGAY LẬP TỨC
        body_text = ""
        if body:
            try:
                body_text = body[:MAX_BODY_LOG].decode("utf-8", errors="replace")
            except Exception:
                body_text = f"<binary {len(body)} bytes>"

        log_entry = {
            "type": "HTTP",
            "method": method,
            "url": url,
            "host": host,
            "path": path,
            "client": f"{client_addr[0]}:{client_addr[1]}",
            "headers": dict(list(headers.items())[:20]),
        }
        if body_text:
            log_entry["body"] = body_text
            log_entry["body_size"] = len(body)

        logger.log(log_entry)

        # Kết nối tới server
        remote_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if bind_ip:
            remote_sock.bind((bind_ip, 0))
        remote_sock.settimeout(30)
        remote_sock.connect((host, port))

        # Gửi request tới server (chuyển absolute URL thành relative)
        request_line = f"{method} {path} {version}\r\n"
        header_lines = "\r\n".join(f"{k}: {v}" for k, v in headers.items())
        raw_request = f"{request_line}{header_lines}\r\n\r\n".encode() + body

        remote_sock.sendall(raw_request)

        # Nhận response và forward cho client
        while True:
            try:
                chunk = remote_sock.recv(BUFFER_SIZE)
                if not chunk:
                    break
                client_sock.sendall(chunk)
            except socket.timeout:
                break

    except Exception as e:
        logger.log({
            "type": "HTTP_ERROR",
            "method": method,
            "url": url,
            "error": str(e)
        })
    finally:
        if remote_sock:
            try:
                remote_sock.close()
            except Exception:
                pass


def handle_client(client_sock, client_addr, bind_ip, logger):
    """Xử lý 1 client connection"""
    try:
        client_sock.settimeout(30)
        data = client_sock.recv(BUFFER_SIZE)
        if not data:
            return

        method, url, version, headers, body = parse_request(data)

        if method == "CONNECT":
            # HTTPS
            host_port = url.split(":")
            host = host_port[0]
            port = int(host_port[1]) if len(host_port) > 1 else 443
            handle_connect(client_sock, host, port, bind_ip, logger, client_addr)
        elif method:
            # HTTP
            handle_http(client_sock, method, url, version, headers, body, bind_ip, logger, client_addr)
        else:
            logger.log({"type": "UNKNOWN", "raw": data[:200].decode("utf-8", errors="replace")})

    except Exception as e:
        logger.log({"type": "ERROR", "client": str(client_addr), "error": str(e)})
    finally:
        try:
            client_sock.close()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="HTTP/HTTPS Proxy with logging")
    parser.add_argument("--port", type=int, required=True, help="Listen port")
    parser.add_argument("--bind-ip", default="", help="Outgoing source IP (PPPoE IP)")
    parser.add_argument("--log", default="/root/nest/logs/proxy.log", help="Log file path")
    parser.add_argument("--listen", default="0.0.0.0", help="Listen address")
    args = parser.parse_args()

    logger = ProxyLogger(args.log)

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.listen, args.port))
    server.listen(100)

    logger.log({
        "type": "START",
        "listen": f"{args.listen}:{args.port}",
        "bind_ip": args.bind_ip or "default"
    })
    print(f"🟢 Proxy listening on {args.listen}:{args.port}, outgoing IP: {args.bind_ip or 'default'}", flush=True)

    while True:
        try:
            client_sock, client_addr = server.accept()
            t = threading.Thread(target=handle_client, args=(client_sock, client_addr, args.bind_ip, logger), daemon=True)
            t.start()
        except KeyboardInterrupt:
            print("\n🔴 Proxy stopped.")
            break
        except Exception as e:
            print(f"Accept error: {e}", flush=True)

    server.close()


if __name__ == "__main__":
    main()

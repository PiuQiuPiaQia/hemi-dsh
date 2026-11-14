#!/usr/bin/env python3
"""Self-signed HTTPS fixture for the WKWebView trust experiment.

Serves the subtest assets, logs every request, and completes one WebSocket
echo exchange so the page can observe whether wss:// is trusted at all.
"""

import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(ROOT, "assets")
LOG_LOCK = threading.Lock()


def log(line: str) -> None:
    with LOG_LOCK:
        print(f"SERVER {line}", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # route through our logger
        log(f"request {self.address_string()} {fmt % args}")

    def _asset(self, name: str, ctype: str):
        try:
            with open(os.path.join(ASSETS, name), "rb") as handle:
                body = handle.read()
        except OSError:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/main.html":
            self._asset("main.html", "text/html; charset=utf-8")
        elif path == "/api.json":
            body = json.dumps({"pong": "yes"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif path == "/script.js":
            self._asset("script.js", "application/javascript")
        elif path == "/module.mjs":
            self._asset("module.mjs", "application/javascript")
        elif path == "/style.css":
            self._asset("style.css", "text/css")
        elif path == "/img.png":
            self._asset("img.png", "image/png")
        elif path == "/font.woff2":
            self._asset("font.woff2", "font/woff2")
        elif path == "/iframe.html":
            self._asset("iframe.html", "text/html; charset=utf-8")
        elif path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/api.json")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif path == "/ws":
            self.handle_websocket()
        elif path == "/ws-redirect":
            # WebSocket negative control: a 3xx answer to the upgrade request.
            self.send_response(302)
            self.send_header("Location", "/ws")
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    def handle_websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key or "websocket" not in (self.headers.get("Upgrade") or "").lower():
            self.send_response(400)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        log("ws handshake complete")
        try:
            # Read client frames until the first text frame, then echo once.
            while True:
                head = self.rfile.read(2)
                if len(head) < 2:
                    return
                opcode = head[0] & 0x0F
                length = head[1] & 0x7F
                masked = bool(head[1] & 0x80)
                if length == 126:
                    length = struct.unpack(">H", self.rfile.read(2))[0]
                elif length == 127:
                    length = struct.unpack(">Q", self.rfile.read(8))[0]
                mask = self.rfile.read(4) if masked else b""
                payload = bytearray(self.rfile.read(length))
                if masked:
                    for index in range(length):
                        payload[index] ^= mask[index % 4]
                if opcode == 0x8:  # close
                    return
                if opcode == 0x1:  # text
                    log(f"ws text {bytes(payload)!r}")
                    message = b"ws-echo"
                    frame = bytes([0x81, len(message)]) + message
                    self.wfile.write(frame)
                    self.wfile.flush()
                    log("ws echo sent")
                    # Hold the socket briefly; the page closes after the echo.
                    try:
                        self.connection.settimeout(5)
                        while True:
                            head = self.rfile.read(2)
                            if len(head) < 2 or (head[0] & 0x0F) == 0x8:
                                return
                    except (socket.timeout, OSError):
                        return
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        finally:
            # Observable server-side close for the socket tests.
            log("ws closed")


def main():
    cert = sys.argv[1]
    key = sys.argv[2]
    port = int(sys.argv[3]) if len(sys.argv) > 3 else 8443
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    # Port 0 means "assign one"; report the actual port so callers allocate atomically.
    log(f"listening https://127.0.0.1:{server.server_address[1]}")
    server.serve_forever()


if __name__ == "__main__":
    main()

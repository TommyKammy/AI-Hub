"""Loopback test relay. Deliver one local model reply slowly to the real Hermes run."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

marker = Path("/tmp/lab-delay-next-model")
timing = Path("/tmp/lab-model-timing.json")


class ModelRelay(BaseHTTPRequestHandler):
    def forward(self):
        if self.path not in ("/v1/chat/completions", "/v1/models"):
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        request = Request("http://hub.lab" + self.path, data=body or None,
                          headers={k: self.headers[k] for k in ("Content-Type", "Authorization") if k in self.headers},
                          method=self.command)
        try:
            response = urlopen(request, timeout=30)
        except HTTPError as error:
            response = error
        with response:
            payload = response.read()
            mime = response.headers.get_content_type()
            self.send_response(response.status)
            self.send_header("Content-Type", mime)
            self.end_headers()
            if self.command == "POST" and response.status == 200 and marker.exists():
                marker.unlink()
                # SSE comments and JSON whitespace carry no model output.
                heartbeat = b": waiting\n\n" if mime == "text/event-stream" else b" "
                started = time.time()
                timing.write_text(json.dumps({"started": started, "contentType": mime}))
                deadline = time.monotonic() + 615
                while time.monotonic() < deadline:
                    self.wfile.write(heartbeat)
                    self.wfile.flush()
                    time.sleep(min(5, max(0, deadline - time.monotonic())))
                timing.write_text(json.dumps({"started": started, "released": time.time(), "contentType": mime}))
            self.wfile.write(payload)

    do_GET = do_POST = forward


ThreadingHTTPServer(("127.0.0.1", 8645), ModelRelay).serve_forever()

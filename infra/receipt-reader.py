"""Read-only lookup for the pinned Hermes runs and session-authority schemas."""
import hashlib
import hmac
import json
import os
import re
import sqlite3
import time
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def receipt(directory, scope, key, attempt):
    session = "hub-" + key
    with closing(sqlite3.connect((directory / "runs_idempotency.db").as_uri() + "?mode=ro",
                                 uri=True, timeout=2)) as db:
        db.execute("ATTACH DATABASE ? AS authority", ((directory / "state.db").as_uri() + "?mode=ro",))
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        bookings = db.execute("""
            SELECT run_id, json_extract(status_json,'$.session_id'), json_extract(status_json,'$.run_id'),
                   json_extract(status_json,'$.status'), acknowledged_at, retention_until, updated_at
            FROM run_idempotency WHERE scope=? AND idempotency_key=? LIMIT 2""", (scope, key)).fetchall()
        admissions = db.execute("""
            SELECT request_id, json_extract(payload_json,'$.api_turn_v1.run_owner_scope'),
                   substr(json_extract(payload_json,'$.text'),1,?)
            FROM authority.session_admissions WHERE principal_id='api' AND target_session_id=? LIMIT 2""",
                                (len("AI_HUB_ROUTE " + attempt + "\n"), session)).fetchall()
    if not bookings or not admissions:
        return {"result": "missing"}
    if len(bookings) != 1 or len(admissions) != 1:
        return {"result": "ambiguous"}
    run, stored_session, stored_run, status, ack, retention, updated = bookings[0]
    if (stored_session != session or stored_run != run or not re.fullmatch(r"run_[a-f0-9]{32}", run or "")
            or admissions[0] != (run, scope, "AI_HUB_ROUTE " + attempt + "\n")):
        return {"result": "mismatch"}
    # Match the pinned store's terminal-record retention; stale rows may await pruning.
    now = time.time()
    if status in {"completed", "failed", "cancelled", "interrupted", "incomplete"} and (
        (ack is not None and ack <= now - 86400) or
        (retention > 0 and retention <= now) or (retention <= 0 and updated < now - 86400)
    ):
        return {"result": "expired"}
    return {"result": "matched", "run_id": run, "session_id": session}


class Reader(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        token = os.environ["API_SERVER_KEY"]
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + token).encode()):
            self.send_error(403)
            return
        match = re.fullmatch(r"/receipt/([a-f0-9-]{36}-(?:review|draft|compose|question-\d+|revise-\d+|actions-[a-zA-Z0-9-]{12,100}))", self.path)
        attempt = self.headers.get("X-Hub-Attempt", "")
        if not match or not re.fullmatch(r"[a-f0-9-]{36}", attempt):
            self.send_error(400)
            return
        scope = hashlib.sha256(("default\0" + token).encode()).hexdigest()
        try:
            result = receipt(Path("/store"), scope, match[1], attempt)
        except (sqlite3.Error, ValueError, TypeError, OSError):
            result = {"result": "unavailable"}
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8643), Reader).serve_forever()

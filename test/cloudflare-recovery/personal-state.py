"""Snapshot and restore the generated personal state of one isolated lab employee."""
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sys

MEMORY_FILES = ("USER.md", "MEMORY.md")
SKILL = re.compile(r"hub-quote-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
MAX_STATE = 100_000


def content(path):
    if path.is_symlink():
        raise ValueError("Personal state requires regular files")
    try:
        return path.read_bytes().decode("utf-8")
    except FileNotFoundError:
        return None


def snapshot(root):
    memory = {name: content(root / "memories" / name) for name in MEMORY_FILES}
    skills = {}
    for child in sorted((root / "skills").glob("hub-quote-*")):
        if SKILL.fullmatch(child.name):
            if child.is_symlink():
                raise ValueError("Personal state requires regular skill directories")
            text = content(child / "SKILL.md")
            if text is not None:
                skills[child.name] = text
    encoded = json.dumps({"memory": memory, "skills": skills}, ensure_ascii=False, separators=(",", ":")).encode()
    if len(encoded) > MAX_STATE:
        raise ValueError("Personal state exceeds the lab limit")
    return encoded


def restore(root, encoded):
    if len(encoded) > MAX_STATE:
        raise ValueError("Personal state exceeds the lab limit")
    state = json.loads(encoded)
    memory, skills = state["memory"], state["skills"]
    if set(memory) != set(MEMORY_FILES) or not all(value is None or isinstance(value, str) for value in memory.values()):
        raise ValueError("Invalid memory snapshot")
    if not all(SKILL.fullmatch(name) and isinstance(value, str) for name, value in skills.items()):
        raise ValueError("Invalid skill snapshot")
    for name, value in memory.items():
        path = root / "memories" / name
        if value is None:
            path.unlink(missing_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value.encode("utf-8"))
    for name, value in skills.items():
        path = root / "skills" / name / "SKILL.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value.encode("utf-8"))


class StateReader(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        token = "Bearer " + os.environ["API_SERVER_KEY"]
        if not hmac.compare_digest(self.headers.get("Authorization", ""), token):
            return self.send_error(403)
        if self.path != "/state":
            return self.send_error(404)
        try:
            body = snapshot(Path("/opt/data"))
        except (OSError, ValueError):
            return self.send_error(503)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if sys.argv[1] == "restore":
        restore(Path("/opt/data"), os.environ["LAB_PERSONAL_STATE"].encode())
    else:
        ThreadingHTTPServer(("0.0.0.0", 8644), StateReader).serve_forever()

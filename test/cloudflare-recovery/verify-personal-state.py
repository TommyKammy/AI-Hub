"""Run the lab snapshot script in fresh containers of the pinned Hermes image."""
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
IMAGE = (HERE / "Dockerfile").read_text().splitlines()[0].split()[-1]
DOCKER = ("docker", "--context", "colima-mac-studio-solo")
SKILL = "hub-quote-39ec3482-8c0a-4178-afe0-bc6b03170a1f"
SKILL_TEXT = "# 本人の見積の基準\n- 納期を優先\n"
OLD_STATE = {
    "memory": {"USER.md": "結論を先に。\n", "MEMORY.md": "削除する旧記憶。\n"},
    "skills": {SKILL: SKILL_TEXT},
}
EMPTY = {"memory": {"USER.md": None, "MEMORY.md": None}, "skills": {}}
SCRIPT = """
import json
import os
from pathlib import Path
import runpy
state = runpy.run_path("/checks/personal-state.py")
path = Path("/tmp/personal-root")
state["restore"](path, os.environ["LAB_STATE"].encode())
if os.environ["LAB_DELETE"] == "1":
    (path / "memories" / "MEMORY.md").unlink()
print(state["snapshot"](path).decode())
"""


def run(state, delete=False):
    cid = subprocess.check_output([
        *DOCKER, "create", "--pull", "never", "--network", "none",
        "--entrypoint", "/opt/hermes/.venv/bin/python",
        "--mount", f"type=bind,src={HERE},dst=/checks,readonly",
        "--env", "LAB_STATE=" + json.dumps(state, ensure_ascii=False),
        "--env", "LAB_DELETE=" + str(int(delete)),
        IMAGE, "-B", "-c", SCRIPT,
    ], text=True).strip()
    try:
        snapshot = subprocess.check_output([*DOCKER, "start", "-a", cid], text=True)
        return cid, json.loads(snapshot)
    finally:
        subprocess.run([*DOCKER, "rm", cid], check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    original, first = run(OLD_STATE)
    removed, second = run(first, delete=True)
    restored, third = run(second)
    different, other = run(EMPTY)
    assert len({original, removed, restored, different}) == 4
    assert first == OLD_STATE
    assert first["memory"]["MEMORY.md"] and third["memory"]["MEMORY.md"] is None
    assert third["memory"]["USER.md"] == OLD_STATE["memory"]["USER.md"]
    assert third["skills"] == {SKILL: SKILL_TEXT}
    assert other == EMPTY
    print(json.dumps({
        "image": IMAGE, "separateContainers": 4, "firstSnapshot": original,
        "snapshotAfterDeletion": removed, "restoredSnapshot": restored,
        "otherEmployee": different, "hashAlgorithm": "SHA-256",
        "profileHash": hashlib.sha256(third["memory"]["USER.md"].encode()).hexdigest(),
        "skillHash": hashlib.sha256(third["skills"][SKILL].encode()).hexdigest(),
        "deletedMemoryReturned": False, "otherEmployeeProfileOrSkillCount": 0,
    }, indent=2))

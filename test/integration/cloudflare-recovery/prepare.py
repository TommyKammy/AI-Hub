"""Prepare an isolated, local-only copy of the Hub and Wrangler fixture."""
from pathlib import Path
import shutil
import subprocess
import sys

here = Path(__file__).resolve().parent
repo = here.parents[2]
target = Path(sys.argv[1]).expanduser().resolve()
# A new directory also means a new Hub database and D1 store.
target.mkdir(mode=0o700)
app = target / "hub"
app.mkdir()
shutil.copy2(repo / "server.mjs", app)
for name in ("infra", "skills", "public", "library-data", "src"):
    shutil.copytree(repo / name, app / name)
for name in ("package.json", "compose.yaml"):
    shutil.copy2(repo / name, app)
for name in ("lab-entry.mjs", "lab.yaml"):
    shutil.copy2(here / name, app)
subprocess.run(["node", "infra/init.mjs"], cwd=app, check=True)
variables = (app / ".runtime/local.env").read_text().splitlines()
keys = [v for v in variables if v.startswith(("SATO_KEY=", "TANAKA_KEY="))]
assert len(keys) == 2
secrets = target / ".dev.vars"
secrets.touch(mode=0o600)
secrets.write_text("\n".join(keys) + "\n")
for name in ("worker.mjs", "schema.sql"):
    shutil.copy2(here / name, target)
(target / "results").mkdir()

# Send only the tools and test configuration to Docker's build context.
image = target / "image"
infra = image / "hub/infra"
infra.mkdir(parents=True)
for name in ("hermes.yaml", "work_tools.py", "receipt-reader.py"):
    source = (repo / "infra" / name).read_text()
    (infra / name).write_text(source.replace("http://hub:18800", "http://hub.lab"))
shutil.copytree(repo / "skills", image / "hub/skills")
for name in ("launch.sh", "Dockerfile", "personal-state.py"):
    shutil.copy2(here / name, image)
shutil.copy2(here / "wrangler.jsonc", target)
if "--slow-model" in sys.argv[2:]:
    shutil.copy2(here / "slow-model.py", image)
    with (image / "Dockerfile").open("a") as dockerfile:
        dockerfile.write("\nCOPY slow-model.py /lab/slow-model.py\n")
    config = infra / "hermes.yaml"
    config.write_text(config.read_text().replace("http://hub.lab/v1", "http://127.0.0.1:8645/v1"))
print(target)

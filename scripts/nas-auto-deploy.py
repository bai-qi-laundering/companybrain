#!/usr/bin/env python3
"""Fail-closed CompanyBrain pull deploy. Run on the NAS with docker access."""
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

REPO = "bai-qi-laundering/companybrain"
WORKFLOW = "companybrain-ci.yml"
ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".companybrain-deployed-sha"
FILES = ("backend/app.mjs", "backend/assistant.mjs", "backend/assistant-store.mjs",
         "backend/domain.mjs", "backend/gemini.mjs", "backend/line.mjs",
         "backend/organizations.mjs", "backend/security.mjs",
         "backend/server.mjs", "backend/store.mjs", "backend/tasks.mjs",
         "backend/package.json", "backend/package-lock.json",
         "backend/Dockerfile", "index.html")
OVERRIDE = ROOT / "compose.autodeploy.yaml"
OVERRIDE_TEXT = """services:
  app:
    environment:
      GARMENT_ADMIN_LINE_USER_IDS: ${GARMENT_ADMIN_LINE_USER_IDS:-}
"""

def api(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "companybrain-nas-pull-deployer",
        "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.urlopen(req, timeout=25) as response:
        return response.read()

def run(*args, check=True):
    return subprocess.run(args, cwd=ROOT, check=check, capture_output=True, text=True)

def compose(*args):
    return run("docker", "compose", "-p", "companybrain",
               "-f", "compose.yaml", "-f", str(OVERRIDE),
               "--env-file", "settings.env", *args)

def healthy():
    try:
        cid = compose("ps", "-q", "app").stdout.strip()
        if not cid:
            return False
        result = run("docker", "inspect", "-f",
                     "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", cid)
        return result.stdout.strip() == "healthy"
    except subprocess.CalledProcessError:
        return False

def wait_healthy(seconds=120):
    for _ in range(seconds // 5):
        if healthy():
            return True
        time.sleep(5)
    return False

def main():
    if not (ROOT / "settings.env").is_file() or not (ROOT / "compose.yaml").is_file():
        raise RuntimeError("settings.env or compose.yaml missing; aborting")
    if not shutil.which("docker"):
        raise RuntimeError("Docker is missing")
    run("docker", "compose", "version")
    head = json.loads(api(f"https://api.github.com/repos/{REPO}/branches/main"))["commit"]["sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        raise RuntimeError("Invalid commit SHA")
    runs = json.loads(api(
        f"https://api.github.com/repos/{REPO}/actions/workflows/{WORKFLOW}/runs"
        "?branch=main&event=push&per_page=30"))["workflow_runs"]
    approved = any(r.get("head_sha") == head and r.get("status") == "completed"
                   and r.get("conclusion") == "success" for r in runs)
    if not approved:
        print("Main HEAD has no successful CI run; no deployment")
        return
    if STATE.exists() and STATE.read_text().strip() == head:
        print("Already deployed:", head[:12])
        return
    print("CI verified for", head[:12], "preparing rollback backup")
    archive = api(f"https://api.github.com/repos/{REPO}/tarball/{head}")
    with tempfile.TemporaryDirectory(prefix="companybrain-update-", dir=str(ROOT)) as temp:
        temp = Path(temp)
        staged = temp / "staged"
        staged.mkdir()
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tf:
            entries = {m.name.split("/", 1)[1]: m for m in tf.getmembers()
                       if "/" in m.name and m.isfile()}
            for name in FILES:
                item = entries.get(name)
                if not item or item.size > 2_000_000:
                    raise RuntimeError("Missing or oversized file in GitHub archive: " + name)
                target = staged / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tf.extractfile(item).read())
        backup = temp / "backup"
        backup.mkdir()
        previous = {}
        for name in FILES:
            dest = ROOT / name
            if dest.is_symlink():
                raise RuntimeError("Refusing to overwrite symlink: " + name)
            previous[name] = dest.exists()
            if dest.exists():
                target = backup / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dest, target)
        override_existed = OVERRIDE.exists()
        if override_existed:
            shutil.copy2(OVERRIDE, backup / "compose.autodeploy.yaml")
        # Do not touch settings.env, .env, compose.yaml, or PostgreSQL volumes.
        try:
            for name in FILES:
                dest = ROOT / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(staged / name, dest)
            OVERRIDE.write_text(OVERRIDE_TEXT)
            compose("config", "-q")
            compose("up", "-d", "--build", "--no-deps", "app")
            if not wait_healthy():
                raise RuntimeError("New app did not become healthy")
            STATE.write_text(head + "\n")
            print("Deployment healthy:", head[:12])
        except Exception:
            print("Deploy failed; restoring application files", file=sys.stderr)
            for name in FILES:
                dest = ROOT / name
                if previous[name]:
                    shutil.copy2(backup / name, dest)
                elif dest.exists():
                    dest.unlink()
            if override_existed:
                shutil.copy2(backup / "compose.autodeploy.yaml", OVERRIDE)
            elif OVERRIDE.exists():
                OVERRIDE.unlink()
            try:
                if override_existed:
                    compose("up", "-d", "--build", "--no-deps", "app")
                else:
                    run("docker", "compose", "-p", "companybrain",
                        "--env-file", "settings.env", "up", "-d",
                        "--build", "--no-deps", "app")
            except Exception as err:
                print("ROLLBACK NEEDS MANUAL ATTENTION:", err, file=sys.stderr)
            raise

if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        print("CompanyBrain deployment aborted:", err, file=sys.stderr)
        sys.exit(1)

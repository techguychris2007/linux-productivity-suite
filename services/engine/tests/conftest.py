"""Shared fixtures: a real atlas-core-host process with a temp data dir."""

import json
import os
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
BIN = ROOT / "crates/atlas-core/target/release/atlas-core-host"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture()
def core(tmp_path):
    if not BIN.exists():
        pytest.skip("build crates/atlas-core first (cargo build --release)")
    port = free_port()
    env = {**os.environ, "ATLAS_DATA_DIR": str(tmp_path / "data"), "ATLAS_CORE_PORT": str(port)}
    proc = subprocess.Popen([str(BIN)], env=env, stderr=subprocess.PIPE)
    info_file = tmp_path / "data/runtime/core.json"
    for _ in range(100):
        if info_file.exists():
            try:
                socket.create_connection(("127.0.0.1", port), 0.2).close()
                break
            except OSError:
                pass
        time.sleep(0.05)
    info = json.loads(info_file.read_text())
    yield info, tmp_path
    proc.terminate()
    proc.wait(5)


def ui(info, cmd, **args):
    req = urllib.request.Request(f"http://127.0.0.1:{info['port']}/v1/{cmd}", data=json.dumps(args).encode(), method="POST",
                                 headers={"authorization": f"Bearer {info['ui_token']}"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())["result"]



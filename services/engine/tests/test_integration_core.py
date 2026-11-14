"""End-to-end: real atlas-core-host binary + engine orchestrator + Drive tools.
The 'user' approves in a separate thread using the UI token, exactly as the shell does."""

import json
import os
import socket
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

import pytest

from atlas_engine.apptools import drive
from atlas_engine.core_client import CoreClient
from atlas_engine.events import EventBus
from atlas_engine.orchestrator import Orchestrator
from atlas_engine.providers import AssistantTurn, ScriptedProvider, ToolCall
from atlas_engine.tools import ToolRegistry

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


def test_drive_task_with_approval(core):
    info, tmp = core
    docs = tmp / "Documents"
    docs.mkdir()
    (docs / "old-draft.txt").write_text("obsolete")
    grant = ui(info, "grants.add", path=str(docs), label="Documents")["id"]

    client = CoreClient(info["port"], info["engine_token"])
    reg = ToolRegistry()
    drive.register(reg, client)
    script = [
        AssistantTurn("", [ToolCall("c1", "drive.list_folders", {})]),
        AssistantTurn("", [ToolCall("c2", "drive.write_text", {"grant": grant, "path": "reports/summary.md", "content": "# Summary\n"})]),
        AssistantTurn("", [ToolCall("c3", "drive.trash", {"grant": grant, "path": "old-draft.txt"})]),
        AssistantTurn("Wrote reports/summary.md and moved old-draft.txt to the Atlas trash."),
    ]
    bus = EventBus()
    provider = ScriptedProvider(script)
    orch = Orchestrator(reg, bus, lambda: provider, approvals=client, verify=False)

    def user_approves():
        for _ in range(200):
            pending = ui(info, "approvals.pending")
            if pending:
                assert "old-draft.txt" in pending[0]["summary"]
                ui(info, "approvals.approve", id=pending[0]["id"])
                return
            time.sleep(0.05)
    threading.Thread(target=user_approves, daemon=True).start()

    task = orch.start("Write a summary and clean up the old draft", background=False)
    assert task.status == "completed", task.error
    assert (docs / "reports/summary.md").read_text() == "# Summary\n"
    assert not (docs / "old-draft.txt").exists()
    types = [e.type for e in bus.since(0)]
    assert "approval.required" in types and "approval.resolved" in types
    audit = ui(info, "audit.recent")
    assert any(e["action"] == "fs.trash" and e["outcome"] == "ok" and e["actor"] == "atlas-ai" for e in audit)


def test_engine_token_cannot_approve(core):
    info, _ = core
    client = CoreClient(info["port"], info["engine_token"])
    with pytest.raises(Exception, match="not available"):
        client.call("approvals.approve", id="x")

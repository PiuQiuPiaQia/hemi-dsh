"""Public Python SDK refusal preserves target metadata and durable fork bytes."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness
from deepseek_harness.errors import JsonRpcError


def test_unavailable_target_parent_and_fork_do_not_activate_on_host(tmp_path: Path) -> None:
    repo = Path(__file__).resolve().parents[3]
    binary = repo / "apps/cli/lib/bin.js"
    if shutil.which("node") is None or not binary.is_file():
        pytest.skip("requires Node and the built shipped dsh CLI")
    fixture = repo / "packages/sdk/client/tests/fixtures/execution-target.mjs"
    workspace = tmp_path / "host-workspace"
    workspace.mkdir()
    marker = workspace / "host-marker.txt"
    marker.write_text("Host data must remain untouched\n", encoding="utf-8")
    logs, report, trace = tmp_path / "sessions", tmp_path / "headers.json", tmp_path / "agents.jsonl"
    patch = tmp_path / "target.patch.yml"
    patch.write_text(
        "- id: session-persistence-jsonl\n  config:\n    root: " + json.dumps(str(logs))
        + "\n    compression: none\n- insert:\n    - id: sdk-execution-target-fixture\n      name: " + json.dumps(str(fixture)) + "\n",
        encoding="utf-8",
    )
    options = dict(
        dsh_bin=str(binary), profile="sdk", patches=(str(patch),), cwd=str(workspace),
        runtime_cwd=str(workspace), dsh_home=str(tmp_path / "home"),
        initialize_timeout_seconds=60, request_timeout_seconds=30, shutdown_timeout_seconds=30,
        api_key="keyless-execution-target",
        env={"DSH_TELEMETRY_DISABLED": "1", "DSH_SDK_TARGET_CWD": str(workspace),
             "DSH_SDK_TARGET_REPORT": str(report), "DSH_SDK_TARGET_TRACE": str(trace)},
    )
    with DeepSeekHarness(**options):
        pass
    before = {path: path.read_bytes() for path in logs.rglob("session*.jsonl")}
    assert len(before) == 2
    refusals = []
    with DeepSeekHarness(**options) as harness:
        for session_id in ("sdk-target-parent", "sdk-target-fork"):
            with pytest.raises(JsonRpcError) as rejected:
                harness.resume_session(session_id)
            refusals.append({"sessionId": session_id, "code": rejected.value.code, "message": rejected.value.message})
    after = {path: path.read_bytes() for path in logs.rglob("session*.jsonl")}
    assert after == before
    actual = {
        "headers": json.loads(report.read_text(encoding="utf-8")),
        "refusals": refusals,
        "agentsCreated": len(trace.read_text(encoding="utf-8").splitlines()),
        "logsUnchanged": True,
        "hostMarkerUnchanged": marker.read_text(encoding="utf-8") == "Host data must remain untouched\n",
    }
    expected = Path(__file__).with_name("expected") / "execution-target.json"
    assert actual == json.loads(expected.read_text(encoding="utf-8"))

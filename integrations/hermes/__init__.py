"""multi-agent-desktop-pet managed Hermes plugin v1."""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict

HOOK_KIND = {
    "on_session_start": "session.started",
    "pre_llm_call": "state.thinking",
    "post_llm_call": "state.working",
    "pre_tool_call": "state.working",
    "post_tool_call": "state.working",
    "on_session_end": "task.completed",
    "on_session_finalize": "session.ended",
    "on_session_reset": "session.started",
}

_active_session = "hermes-default"
_session_lock = threading.Lock()


def _bridge_path() -> Path:
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "AgentPetHub" / "integrations" / "agent-pet-hook.mjs"


def _session_id(kwargs: Dict[str, Any]) -> str:
    global _active_session
    explicit = str(kwargs.get("session_id") or kwargs.get("session_key") or "").strip()
    with _session_lock:
        if explicit:
            _active_session = explicit
        return explicit or _active_session


def _has_error(result: Any) -> bool:
    if isinstance(result, dict):
        code = result.get("exit_code")
        return bool(result.get("error")) or (isinstance(code, int) and code != 0)
    return False


def _payload(event_name: str, kwargs: Dict[str, Any]) -> tuple[str, Dict[str, Any]]:
    tool_name = str(kwargs.get("tool_name") or "").strip()
    kind = HOOK_KIND[event_name]
    if event_name == "post_tool_call" and _has_error(kwargs.get("result")):
        kind = "task.failed"
    if event_name == "on_session_end" and kwargs.get("completed") is False and kwargs.get("interrupted") is not True:
        kind = "task.failed"
    if event_name == "pre_tool_call" and tool_name == "clarify":
        kind = "question.asked"
    summaries = {
        "on_session_start": "Hermes 会话已经开始",
        "pre_llm_call": "Hermes 正在理解任务",
        "post_llm_call": "Hermes 已完成思考，正在整理结果",
        "pre_tool_call": f"正在使用 {tool_name or '工具'}",
        "post_tool_call": f"已完成 {tool_name or '工具'}，继续处理任务",
        "on_session_end": "Hermes 已经完成这一轮任务",
        "on_session_finalize": "Hermes 会话已经结束",
        "on_session_reset": "Hermes 已开始新会话",
    }
    args = kwargs.get("args") if isinstance(kwargs.get("args"), dict) else {}
    payload = {
        "session_id": _session_id(kwargs),
        "cwd": os.getcwd(),
        "title": "Hermes 会话",
        "summary": summaries[event_name],
        "reason": "Hermes 工具执行失败" if kind == "task.failed" else None,
        "tool_name": tool_name or None,
        "tool_input": args,
        "tool_use_id": kwargs.get("tool_call_id") or kwargs.get("task_id"),
    }
    return kind, payload


def _send(kind: str, payload: Dict[str, Any]) -> None:
    try:
        bridge = _bridge_path()
        if not bridge.exists():
            return
        node = "node.exe" if os.name == "nt" else "node"
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        process = subprocess.Popen(
            [node, str(bridge), "hermes", kind],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            creationflags=creationflags,
        )
        process.communicate(json.dumps(payload, ensure_ascii=False), timeout=1.5)
    except Exception:
        return


def _callback(event_name: str):
    def callback(**kwargs: Any) -> None:
        try:
            kind, payload = _payload(event_name, kwargs)
            threading.Thread(target=_send, args=(kind, payload), daemon=True).start()
        except Exception:
            pass
        return None

    callback.__name__ = f"agent_pet_{event_name}"
    return callback


def register(ctx) -> None:
    for hook_name in HOOK_KIND:
        ctx.register_hook(hook_name, _callback(hook_name))

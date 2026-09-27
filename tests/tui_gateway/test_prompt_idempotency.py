"""Durable text prompt.submit identity across RPC retries, busy admission and cold resume.

All requests run through the real JSON-RPC dispatcher and a temporary SessionDB. The model
worker is held at the edge; no live provider, gateway or installed profile is touched.
"""

import contextlib
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from hermes_state import SessionDB
from tui_gateway import server


@pytest.fixture
def gateway(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    launched = []
    events = []

    class HeldThread:
        def __init__(self, target, **_kwargs):
            self.target = target

        def start(self):
            launched.append(self.target)

    class ThreadProxy:
        Thread = HeldThread

        def __getattr__(self, name):
            return getattr(threading, name)

    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_schedule_agent_build", lambda _sid: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_a: None)
    monkeypatch.setattr(server, "_start_agent_build", lambda *_a: None)
    monkeypatch.setattr(server, "_restart_completed_failed_agent_build", lambda *_a: False)
    # Never mutate the process-global threading.Thread: pytest, its runner and
    # the executor use it internally. Replace only the gateway module binding.
    monkeypatch.setattr(server, "threading", ThreadProxy())
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload=None: events.append((event, sid, payload)))
    try:
        out = server.handle_request({"id": "create", "method": "session.create",
                                     "params": {"cols": 96, "source": "desktop"}})
        assert "result" in out, out
        sid = out["result"]["session_id"]
        key = out["result"]["stored_session_id"]
        yield db, sid, key, launched, events
    finally:
        server._sessions.pop(sid, None)
        db.close()


def submit(sid, text="send once", client_id="native-1", **params):
    return server.handle_request({"id": "request", "method": "prompt.submit", "params": {
        "session_id": sid, "text": text, "client_message_id": client_id, **params}})


def rows(db, key):
    return db.get_messages_as_conversation(key, include_row_ids=True)


def test_first_send_lost_reply_and_conflict_keep_one_durable_user_row(gateway):
    db, sid, key, launched, _events = gateway
    assert db.get_session(key) is None  # session.create is deliberately lazy
    first = submit(sid)
    assert first.get("result", {}).get("status") == "streaming", first
    receipt = first["result"]
    assert receipt["client_message_id"] == "native-1"
    assert db.get_session(key) is not None
    assert [(m["role"], m["content"]) for m in rows(db, key)] == [("user", "send once")]
    assert receipt["user_row_id"] == rows(db, key)[0]["_row_id"]
    assert db.get_session(key)["message_count"] == 1

    # Pretend the first RPC reply never reached the client. Two concurrent callers replay it.
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(lambda _: submit(sid), range(2)))
    assert [r["result"] for r in replies] == [receipt, receipt]
    conflict = submit(sid, text="different payload")
    assert conflict.get("error", {}).get("code") == 4096, conflict
    assert len(rows(db, key)) == len(launched) == 1
    assert db.get_prompt_receipt(key, "native-1")["state"] == "reserved"


def test_capability_advertises_receipt_protocol(gateway):
    response = server.handle_request({"id": "caps", "method": "gateway.capabilities", "params": {}})
    assert response["result"]["identified_prompt_submit"] is True


def test_simultaneous_first_submit_is_one_durable_turn(gateway):
    db, sid, key, launched, _events = gateway
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(lambda _: submit(sid), range(2)))
    assert all(reply.get("result", {}).get("client_message_id") == "native-1" for reply in replies)
    assert replies[0]["result"] == replies[1]["result"]
    assert len(rows(db, key)) == len(launched) == 1


@pytest.mark.parametrize("mode,legacy_status", [
    ("queue", "queued"), ("steer", "steered"), ("interrupt", "redirected")])
def test_identified_busy_send_queues_durably_instead_of_legacy_correction(
        gateway, monkeypatch, mode, legacy_status):
    db, sid, key, launched, _events = gateway
    session = server._sessions[sid]
    calls = []
    session["agent"] = SimpleNamespace(
        _supports_active_turn_redirect=True,
        steer=lambda text: calls.append(("steer", text)) or True,
        redirect=lambda text: calls.append(("redirect", text)) or True,
        interrupt=lambda: calls.append(("interrupt", None)))
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: mode)
    session["running"] = True
    server._start_inflight_turn(session, "send once")
    first = submit(sid, text="send once")  # same text as the active turn is still a DISTINCT send
    assert first.get("result", {}).get("status") == "queued", first
    assert submit(sid, text="send once")["result"] == first["result"]
    assert not calls and not launched and not rows(db, key)
    assert db.get_prompt_receipt(key, "native-1")["state"] == "queued"
    assert session["queued_prompt"]["client_message_id"] == "native-1"
    assert not session.get("queued_prompts")

    # Non-identified callers retain the original policy; identified callers never steer/redirect.
    legacy = server._handle_busy_submit("legacy", sid, session, "a correction", None)
    assert legacy["result"]["status"] == legacy_status
    assert calls == ([("steer", "a correction")] if mode == "steer" else
                     [("redirect", "a correction")] if mode == "interrupt" else [])
    assert db.get_prompt_receipt(key, "native-1")["state"] == "queued"


def test_cold_resume_of_reaped_reserved_turn_reuses_row_and_started_turn_is_uncertain(gateway):
    db, sid, key, launched, _events = gateway
    first = submit(sid)
    assert first.get("result", {}).get("status") == "streaming", first
    row_id = first["result"]["user_row_id"]
    server._sessions.pop(sid)
    db.end_session(key, "ws_orphan_reap")
    resumed = server.handle_request({"id": "resume", "method": "session.resume",
                                     "params": {"session_id": key}})
    assert "result" in resumed, resumed
    other_sid = resumed["result"]["session_id"]
    try:
        assert other_sid != sid
        retry = submit(other_sid)
        assert retry.get("result", {}).get("user_row_id") == row_id, retry
        assert len(rows(db, key)) == 1
        assert len(launched) == 2  # only the unstarted reserved turn may be re-dispatched
        assert db.advance_prompt_receipt(key, "native-1", "reserved", "started")
        server._sessions.pop(other_sid)
        uncertain = submit_after_cold_resume(db, key)
        assert uncertain.get("error", {}).get("code") == 4097, uncertain
        assert uncertain["error"]["data"]["receipt_state"] == "uncertain"
        assert len(rows(db, key)) == 1 and len(launched) == 2
    finally:
        server._sessions.pop(other_sid, None)


def submit_after_cold_resume(db, key):
    result = server.handle_request({"id": "reopen", "method": "session.resume",
                                    "params": {"session_id": key}})
    assert "result" in result, result
    sid = result["result"]["session_id"]
    try:
        return submit(sid)
    finally:
        server._sessions.pop(sid, None)


def test_queued_receipt_survives_restart_and_drains_once(gateway):
    db, sid, key, launched, _events = gateway
    session = server._sessions[sid]
    session["running"] = True  # simulate prior turn still running
    first = submit(sid, text="next turn")
    assert first.get("result", {}).get("status") == "queued", first
    assert not rows(db, key)
    server._sessions.pop(sid)
    db.end_session(key, "ws_orphan_reap")
    resumed = server.handle_request({"id": "resume", "method": "session.resume",
                                     "params": {"session_id": key}})
    assert "result" in resumed, resumed
    other_sid = resumed["result"]["session_id"]
    try:
        retry = submit(other_sid, text="next turn")
        assert retry.get("result", {}).get("status") == "streaming", retry
        assert retry["result"]["user_row_id"] == rows(db, key)[0]["_row_id"]
        assert db.get_prompt_receipt(key, "native-1")["state"] == "reserved"
        assert len(rows(db, key)) == 1
        # A freshly resumed session may have no agent yet. The first queue
        # drain can reserve its row without starting a model; retransmission
        # must adopt that exact row and schedule the deferred build only once.
        assert not launched
        second = submit(other_sid, text="next turn")
        assert second["result"] == retry["result"]
        assert len(launched) == len(rows(db, key)) == 1
        assert submit(other_sid, text="next turn")["result"] == retry["result"]
        assert len(launched) == len(rows(db, key)) == 1
    finally:
        server._sessions.pop(other_sid, None)


def test_staged_attachments_fail_closed_without_consuming_them(gateway):
    db, sid, key, launched, _events = gateway
    session = server._sessions[sid]
    session["attached_images"] = ["/tmp/staged.png"]
    out = submit(sid)
    assert out.get("error", {}).get("code") == 4004, out
    assert session["attached_images"] == ["/tmp/staged.png"]
    assert db.get_prompt_receipt(key, "native-1") is None
    assert not rows(db, key) and not launched


def test_execution_fence_and_start_event_carry_exact_client_id(gateway, monkeypatch):
    db, sid, key, launched, events = gateway
    first = submit(sid)
    assert "result" in first, first
    session = server._sessions[sid]
    agent = SimpleNamespace(session_id=key, interim_assistant_callback=None)
    # Drive the real turn wrapper/fence/event and its finally, but stop before any model call.
    monkeypatch.setattr(server, "_admit_prompt_turn", lambda *_a: ([], agent))
    monkeypatch.setattr(server, "_start_session_work", lambda target, **_k: target() or object())
    monkeypatch.setattr(server, "_prepare_turn_input", lambda *_a: None)
    monkeypatch.setattr(server, "_finish_turn", lambda *_a: None)
    monkeypatch.setattr(server, "_record_turn_marker", lambda *_a, **_k: key)
    monkeypatch.setattr(server, "_retire_turn_marker", lambda *_a: None)
    monkeypatch.setattr(server, "_emit_settled_session_info", lambda *_a: None)
    monkeypatch.setattr(server, "_run_post_turn_followups", lambda *_a: None)
    monkeypatch.setattr(server, "_session_profile_runtime_scope", lambda _s, **_k: contextlib.nullcontext())
    monkeypatch.setattr("agent.notification_presentation.notification_policy_snapshot",
                        lambda *_a, **_k: contextlib.nullcontext())
    monkeypatch.setattr("agent.notification_presentation.notification_turn",
                        lambda *_a, **_k: contextlib.nullcontext())
    monkeypatch.setattr("agent.notification_presentation.notification_config_snapshot", lambda: {})
    monkeypatch.setattr("gateway.warning_notifications.diagnostic_turn_muted", lambda *_a: False)
    session["agent"] = agent
    assert server._run_prompt_submit("rid", sid, session, "send once") is True
    assert db.get_prompt_receipt(key, "native-1")["state"] == "finished"
    starts = [payload for event, _sid, payload in events if event == "message.start"]
    assert starts == [{"client_message_id": "native-1", "user_row_id": first["result"]["user_row_id"]}]
    assert submit(sid)["result"]["status"] == "finished"
    assert len(rows(db, key)) == 1 and len(launched) == 1

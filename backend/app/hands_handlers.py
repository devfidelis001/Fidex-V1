"""Windows Hands requests (real mouse/keyboard control for Take Over; see hands.py).

    hands.status   {}                      ->  {available, platform, screen:{width,height}} (or error when unavailable)
    hands.start    {}                      ->  same as status; starts a fresh Take Over session
    hands.plan     {instruction?}          ->  {say, action|null, done}. Qwen picks the next supported action; action has id, describe, requires_approval
    hands.plan_all {instruction}           ->  {say, steps:[actions]}. Plans the whole task once, then unloads the model\n    hands.approve  {action_id, approved}   ->  {id, approved}
    hands.execute  {action_id}             ->  {ok, detail|error, action, duration_ms, screen, data}  (the REAL result)
    hands.ire_start {instruction, done?}   ->  {job}. Incremental Read-and-Execute: steps become available while the model is still writing\n    hands.ire_poll {job, cursor}           ->  {state, steps:[new actions], say, error}\n    hands.ire_cancel {job}                 ->  {cancelled}\n    hands.stop     {}                      ->  {stopped: true}. Stops planning and any running action at once
"""
from __future__ import annotations

from . import brain, hands
from .handlers import handler
from .protocol import INVALID_PAYLOAD, RequestError


def _only(payload: dict, allowed: tuple) -> None:
    for key in payload:
        if key not in allowed:
            raise RequestError(INVALID_PAYLOAD, f"Unknown field '{key}'.")


@handler("hands.status")
def hands_status(payload: dict) -> dict:
    _only(payload, ())
    return hands.status()


@handler("hands.metrics")
def hands_metrics(payload: dict) -> dict:
    _only(payload, ())
    return {"timings": hands.metrics()}


@handler("hands.start")
def hands_start(payload: dict) -> dict:
    _only(payload, ())
    return hands.start()


@handler("hands.plan")
def hands_plan(payload: dict) -> dict:
    _only(payload, ("instruction",))
    return hands.plan(payload.get("instruction"))


@handler("hands.plan_all")
def hands_plan_all(payload: dict) -> dict:
    _only(payload, ("instruction",))
    return hands.plan_all(payload.get("instruction"))


@handler("hands.plan_start")
def hands_plan_start(payload: dict) -> dict:
    _only(payload, ("instruction",))
    return hands.plan_all_start(payload.get("instruction"))


@handler("hands.plan_result")
def hands_plan_result(payload: dict) -> dict:
    _only(payload, ("job",))
    return hands.plan_all_result(payload.get("job"))


@handler("hands.approve")
def hands_approve(payload: dict) -> dict:
    _only(payload, ("action_id", "approved"))
    return hands.approve(payload.get("action_id"), payload.get("approved"))


@handler("hands.execute")
def hands_execute(payload: dict) -> dict:
    _only(payload, ("action_id",))
    return hands.execute(payload.get("action_id"))


@handler("hands.retry")
def hands_retry(payload: dict) -> dict:
    _only(payload, ("action_id",))
    return hands.retry(payload.get("action_id"))


@handler("hands.recover")
def hands_recover(payload: dict) -> dict:
    _only(payload, ("goal", "failed", "error", "done", "attempt"))
    return hands.recover(payload.get("goal"), payload.get("failed"), payload.get("error"), payload.get("done"), payload.get("attempt", 1))


@handler("hands.recover_start")
def hands_recover_start(payload: dict) -> dict:
    _only(payload, ("goal", "failed", "error", "done", "attempt", "action_id"))
    return hands.recover_start(payload.get("goal"), payload.get("failed"), payload.get("error"), payload.get("done"), payload.get("attempt", 1), payload.get("action_id"))


@handler("hands.recover_result")
def hands_recover_result(payload: dict) -> dict:
    _only(payload, ("job",))
    return hands.recover_result(payload.get("job"))


@handler("hands.stop")
def hands_stop(payload: dict) -> dict:
    _only(payload, ())
    return hands.stop()


@handler("hands.ire_start")
def hands_ire_start(payload: dict) -> dict:
    _only(payload, ("instruction", "done"))
    return hands.ire_start(payload.get("instruction"), payload.get("done"))


@handler("hands.ire_poll")
def hands_ire_poll(payload: dict) -> dict:
    _only(payload, ("job", "cursor"))
    return hands.ire_poll(payload.get("job"), payload.get("cursor", 0))


@handler("hands.ire_cancel")
def hands_ire_cancel(payload: dict) -> dict:
    _only(payload, ("job",))
    return hands.ire_cancel(payload.get("job"))


@handler("hands.warm")
def hands_warm(payload: dict) -> dict:
    _only(payload, ())
    return hands.warm()


@handler("hands.show_desktop")
def hands_show_desktop(payload: dict) -> dict:
    _only(payload, ())
    return hands.show_desktop()


@handler("autopilot.start")
def autopilot_start(payload: dict) -> dict:
    from . import autopilot  # noqa: PLC0415
    return autopilot.start(str(payload.get("instruction") or ""), payload.get("project"), payload.get("goal"))


@handler("autopilot.next")
def autopilot_next(payload: dict) -> dict:
    from . import autopilot  # noqa: PLC0415
    return autopilot.next_task()


@handler("autopilot.report")
def autopilot_report(payload: dict) -> dict:
    from . import autopilot  # noqa: PLC0415
    return autopilot.report(bool(payload.get("ok")))


@handler("hands.pause")
def hands_pause(payload: dict) -> dict:
    _only(payload, ("paused",))
    return hands.pause(bool(payload.get("paused")))


@handler("hands.focus_mark")
def hands_focus_mark(payload: dict) -> dict:
    _only(payload, ())
    return hands.focus_mark()


# ---------- hand-off of big tasks to another AI (delegate.py) ----------
from . import delegate  # noqa: E402


@handler("delegate.check")
def delegate_check(payload: dict) -> dict:
    _only(payload, ("instruction",))
    return delegate.check(payload.get("instruction"))


@handler("delegate.plan")
def delegate_plan(payload: dict) -> dict:
    _only(payload, ("instruction", "ai"))
    return delegate.plan(payload.get("instruction"), payload.get("ai"))


# ---------- Take Over brain (brain.py): past work + learned knowledge ----------
@handler("brain.recent")
def brain_recent(payload: dict) -> dict:
    _only(payload, ("limit",))
    return {"items": brain.recent(payload.get("limit", 30))}


@handler("brain.known")
def brain_known(payload: dict) -> dict:
    _only(payload, ("kind",))
    return {"items": brain.known(payload.get("kind"))}


@handler("brain.remember")
def brain_remember(payload: dict) -> dict:
    _only(payload, ("kind", "key", "value", "secret"))
    return {"stored": brain.remember(payload.get("kind"), payload.get("key"), payload.get("value"), bool(payload.get("secret")))}


@handler("brain.learn")
def brain_learn(payload: dict) -> dict:
    _only(payload, ("text",))
    return brain.learn(payload.get("text"))


@handler("brain.selftest")
def brain_selftest(payload: dict) -> dict:
    _only(payload, ())
    return brain.selftest()


@handler("brain.resolve")
def brain_resolve(payload: dict) -> dict:
    _only(payload, ("text",))
    return brain.resolve(payload.get("text"))


@handler("hands.see_check")
def hands_see_check(payload: dict) -> dict:
    _only(payload, ("goal", "done"))
    return hands.see_check(payload.get("goal"), payload.get("done"))

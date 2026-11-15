"""Action Decision Engine requests (see action_engine.py).

    action.decide  {instruction}              ->  {needs_action, source, tool, params, say, action|null, done, reason}
    action.run     {action_id, approved}      ->  {ok, declined, result, reply}   (executes via hands.approve + hands.execute)
"""
from __future__ import annotations

from . import action_engine
from .handlers import handler
from .protocol import INVALID_PAYLOAD, RequestError


def _only(payload: dict, allowed: tuple) -> None:
    for key in payload:
        if key not in allowed:
            raise RequestError(INVALID_PAYLOAD, f"Unknown field '{key}'.")


@handler("action.decide")
def action_decide(payload: dict) -> dict:
    _only(payload, ("instruction", "rules_only"))
    return action_engine.decide(payload.get("instruction"), payload.get("rules_only") is True)


@handler("action.run")
def action_run(payload: dict) -> dict:
    _only(payload, ("action_id", "approved"))
    return action_engine.run(payload.get("action_id"), payload.get("approved"))

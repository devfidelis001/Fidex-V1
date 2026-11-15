"""Research & Problem Solving requests.

    research.start   {problem, focus: "jobs"|"advertisement"|"any"}  ->  {run_id}     (the work continues in the background)
    research.status  {run_id}                                          ->  snapshot of the run
    research.cancel  {run_id}                                          ->  {run_id, cancelling}
    research.focus   {}                                                ->  {areas:[{id,label}]}

While a run works, the backend sends {event:"research.event", data:<snapshot>} lines; the snapshot lists the real
activities (search, read, extract, analyse...), their state (pending/active/done/failed/skipped), the sources,
findings and, at the end, the report.
"""
from __future__ import annotations

from . import research
from .handlers import handler
from .protocol import INVALID_PAYLOAD, RequestError


def _only(payload: dict, allowed: tuple) -> None:
    for key in payload:
        if key not in allowed:
            raise RequestError(INVALID_PAYLOAD, f"Unknown field '{key}'.")


@handler("research.start")
def research_start(payload: dict) -> dict:
    _only(payload, ("problem", "focus"))
    return research.start(payload.get("problem"), payload.get("focus", "any"))


@handler("research.status")
def research_status(payload: dict) -> dict:
    _only(payload, ("run_id",))
    return research.get(payload.get("run_id")).snapshot()


@handler("research.cancel")
def research_cancel(payload: dict) -> dict:
    _only(payload, ("run_id",))
    return research.cancel(payload.get("run_id"))


@handler("research.build")
def research_build(payload: dict) -> dict:
    _only(payload, ("run_id",))
    return research.build(payload.get("run_id"))


@handler("research.build_stop")
def research_build_stop(payload: dict) -> dict:
    _only(payload, ("run_id",))
    return research.build_stop(payload.get("run_id"))


@handler("research.finish")
def research_finish(payload: dict) -> dict:
    _only(payload, ("run_id",))
    return research.finish(payload.get("run_id"))


@handler("research.note")
def research_note(payload: dict) -> dict:
    _only(payload, ("run_id", "text"))
    return research.add_note(payload.get("run_id"), payload.get("text"))


@handler("research.focus")
def research_focus(payload: dict) -> dict:
    return {"areas": [{"id": k, "label": k.title()} for k in research.FOCUS]}

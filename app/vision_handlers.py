"""Live Desktop Vision requests (see vision.py). All local.

    vision.start    {}  ->  status     starts DXcam capture + Ollama understanding
    vision.pause    {}  ->  status     holds capture and analysis (the camera stays ready)
    vision.resume   {}  ->  status
    vision.stop     {}  ->  status     ends the capture thread and clears what was seen
    vision.status   {}  ->  {state, running, paused, error, summary, age_s, frames, analysed, capture_fps, screen, model, ...}
Event pushed to the UI: "vision.update" (same fields as vision.status), so the UI never has to poll.
"""
from __future__ import annotations

from . import handlers, vision
from .handlers import handler
from .protocol import INVALID_PAYLOAD, RequestError


def _none(payload: dict) -> None:
    if payload:
        raise RequestError(INVALID_PAYLOAD, "This request takes no fields.")


vision.set_emitter(lambda name, data: handlers.emit(name, data))


@handler("vision.start")
def vision_start(payload: dict) -> dict:
    _none(payload)
    return vision.start()


@handler("vision.pause")
def vision_pause(payload: dict) -> dict:
    _none(payload)
    return vision.pause()


@handler("vision.resume")
def vision_resume(payload: dict) -> dict:
    _none(payload)
    return vision.resume()


@handler("vision.stop")
def vision_stop(payload: dict) -> dict:
    _none(payload)
    return vision.stop()


@handler("vision.status")
def vision_status(payload: dict) -> dict:
    _none(payload)
    return vision.status()

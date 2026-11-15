"""Image Creator request (cloud, Cloudflare Workers AI):

    image.generate  {prompt, steps?}  ->  {image (base64 JPEG), mime, model, prompt}
"""
from __future__ import annotations

from . import image_gen
from .handlers import handler
from .protocol import INVALID_PAYLOAD, RequestError


@handler("image.generate")
def image_generate(payload: dict) -> dict:
    prompt = payload.get("prompt")
    if not isinstance(prompt, str):
        raise RequestError(INVALID_PAYLOAD, "'prompt' must be text.")
    try:
        return image_gen.generate(prompt, payload.get("steps") or 4)
    except image_gen.ImageError as e:
        raise RequestError(e.code, e.message)

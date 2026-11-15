"""Cloud image generation through Cloudflare Workers AI (FLUX.1 schnell). Credentials come ONLY from the backend environment:

    CLOUDFLARE_API_TOKEN    required (Workers AI permission)
    CLOUDFLARE_ACCOUNT_ID   optional (defaults to the FIDEX account)
"""
from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request

MODEL = "@cf/black-forest-labs/flux-1-schnell"
DEFAULT_ACCOUNT_ID = "025a175a533864b12196abdc331eb049"
MAX_PROMPT = 2048
TIMEOUT_S = 90


def _from_dotenv(name: str) -> str:
    """Fallback when the variable is not in the process environment: read backend/.env or the project-root .env (backend-only, never sent to the window)."""
    here = os.path.dirname(os.path.abspath(__file__))
    for folder in (os.path.dirname(here), os.path.dirname(os.path.dirname(here))):
        try:
            with open(os.path.join(folder, ".env"), encoding="utf-8-sig") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("export "):
                        line = line[7:]
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    if k.strip() == name and v.strip().strip("\"'"):
                        return v.strip().strip("\"'")
        except OSError:
            continue
    return ""


def _setting(name: str) -> str:
    return (os.environ.get(name) or "").strip() or _from_dotenv(name)


class ImageError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def generate(prompt: str, steps: int = 4) -> dict:
    token = _setting("CLOUDFLARE_API_TOKEN")
    if not token:
        raise ImageError("NO_API_TOKEN", "CLOUDFLARE_API_TOKEN not found. Create backend\\.env containing CLOUDFLARE_API_TOKEN=your_token, or set it in your environment, then fully restart FIDEX AI.")
    account = _setting("CLOUDFLARE_ACCOUNT_ID") or DEFAULT_ACCOUNT_ID
    prompt = (prompt or "").strip()
    if not prompt:
        raise ImageError("EMPTY_PROMPT", "Describe the image you want first.")
    prompt = prompt[:MAX_PROMPT]
    steps = max(1, min(8, int(steps or 4)))
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{MODEL}",
        data=json.dumps({"prompt": prompt, "steps": steps}).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        detail = ""
        try:
            errs = json.loads(raw).get("errors") or []
            detail = "; ".join(str(x.get("message", x)) for x in errs)
        except Exception:  # noqa: BLE001
            detail = raw[:200]
        if e.code in (401, 403):
            raise ImageError("AUTH_FAILED", f"Cloudflare rejected the API token ({e.code}). Check CLOUDFLARE_API_TOKEN has Workers AI access. {detail}".strip())
        if e.code == 429:
            raise ImageError("RATE_LIMITED", "Cloudflare rate limit or daily free quota reached. Try again later.")
        low = detail.lower()
        if e.code == 400 and ("nsfw" in low or "flagged" in low or "safety" in low or "inappropriate" in low):
            raise ImageError("PROMPT_REJECTED", "Can't run this now. Change the prompt.")
        if e.code == 400 and ("prompt" in low and ("short" in low or "long" in low or "empty" in low)):
            raise ImageError("BAD_PROMPT", "Your description is too short or too long. Describe the image in one or two clear sentences.")
        raise ImageError("API_ERROR", f"The image service had a problem (error {e.code}). Please try again in a moment.")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ImageError("NETWORK", f"Could not reach Cloudflare ({getattr(e, 'reason', e)}). Check your internet connection.")
    try:
        data = json.loads(body)
        b64 = (data.get("result") or {}).get("image")
        if not data.get("success", True) or not b64:
            raise ValueError
        base64.b64decode(b64, validate=False)
    except Exception:  # noqa: BLE001
        raise ImageError("BAD_RESPONSE", "Cloudflare returned no image. Try again.")
    return {"image": b64, "mime": "image/jpeg", "model": MODEL, "prompt": prompt}

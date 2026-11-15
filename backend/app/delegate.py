"""Hand-off of BIG tasks to another AI (Claude, ChatGPT, Gemini...) chosen by the user.

The local brain is small and fast for computer actions. A task like "build a website for my company" or "plan my business" is
too big for it, so FIDEX AI writes one good prompt, opens the user's chosen AI in the browser, pastes the prompt and sends it.
Nothing here uses the model: the check and the prompt are instant. Steps go through the SAME gate as every other action
(hands.register -> hands.execute), so Stop and the real-result reporting keep working.

    delegate.check {instruction}      ->  {big, ai, ais}   big: should this go to another AI? ai: the AI named in the text (or "")
    delegate.plan  {instruction, ai}  ->  {ai, label, prompt, steps:[actions]}
"""
from __future__ import annotations

import logging
import os
import re

from . import hands
from .protocol import INVALID_PAYLOAD, RequestError

log = logging.getLogger("fidex.delegate")

AIS = {
    "claude": ("Claude", "https://claude.ai/new"),
    "chatgpt": ("ChatGPT", "https://chatgpt.com/"),
    "gemini": ("Gemini", "https://gemini.google.com/app"),
    "copilot": ("Copilot", "https://copilot.microsoft.com/"),
    "perplexity": ("Perplexity", "https://www.perplexity.ai/"),
    "deepseek": ("DeepSeek", "https://chat.deepseek.com/"),
    "grok": ("Grok", "https://grok.com/"),
}
ALIASES = {"chat gpt": "chatgpt", "chat-gpt": "chatgpt", "gpt": "chatgpt", "openai": "chatgpt", "anthropic": "claude", "bing": "copilot"}
CHROME_PROFILE = os.environ.get("FIDEX_CHROME_PROFILE", "").strip()  # e.g. "Default" or "Profile 1": opens Chrome straight in that account, so no "who is using Chrome?" picker
PAGE_WAIT = 6.0  # seconds the AI page gets to load before the prompt is pasted (the Win+R launch already waits ~3.5s on top)
MAX_PROMPT = 6000
INCLUDE_MEMORY = True  # add what FIDEX AI knows about the user (company, goals) to the prompt, so the other AI does not start blind
MEMORY_CHARS = 600

MAKE = r"(?:build|make|create|design|develop|code|program|plan|draft|write|research|prepare|set\s*up|launch|start)"
THING = r"(?:web\s*site|web\s*page|landing\s*page|app|application|software|system|platform|online\s*store|e-?commerce|shop|blog|dashboard|game|business\s*plan|marketing\s*plan|strategy|brand(?:ing)?|logo|proposal|report|presentation|pitch\s*deck|course|curriculum|content\s*plan|plan)"
BIG_RE = re.compile(rf"\b{MAKE}\b[^.\n]{{0,60}}\b{THING}\b|\bwe\s+need\s+(?:a|an|to\s+make|to\s+build)\b[^.\n]{{0,60}}\b{THING}\b", re.I)
SMALL_RE = re.compile(r"\b(folder|directory|file|notepad|calculator|calc|paint|mouse|click|scroll|press|key|volume|screenshot)\b", re.I)
ASK_RE = re.compile(r"\b(?:ask|use|with|using|open|in|on|via)\s+(claude|chat\s*-?\s*gpt|gpt|gemini|copilot|perplexity|deepseek|grok|openai|anthropic)\b", re.I)
ROLES = (
    (re.compile(r"web\s*site|web\s*page|landing|app\b|application|software|system|platform|store|shop|blog|dashboard|game|code|program", re.I), "senior full-stack web developer and UI designer"),
    (re.compile(r"business|marketing|strategy|plan|brand|pitch|proposal|company", re.I), "senior business strategist and consultant"),
    (re.compile(r"research|report|course|curriculum|content", re.I), "senior researcher and writer"),
)


def key_for(name: str) -> str:
    """'ChatGPT', 'chat gpt', 'openai' -> 'chatgpt'. Returns '' when it is not one of the known AIs."""
    k = re.sub(r"\s+", " ", str(name or "").strip().lower())
    k = ALIASES.get(k, k.replace(" ", ""))
    return k if k in AIS else ""


def named_ai(text: str) -> str:
    m = ASK_RE.search(text or "")
    return key_for(m.group(1)) if m else ""


def is_big(text: str) -> bool:
    text = (text or "").strip()
    if not text or len(text) < 12:
        return False
    if named_ai(text) and re.search(rf"\b{MAKE}\b|\bask\b|\bplan\b", text, re.I) and not SMALL_RE.search(text):
        return True
    return bool(BIG_RE.search(text)) and not SMALL_RE.search(text)


def _context(task: str) -> str:
    if not INCLUDE_MEMORY:
        return ""
    try:
        from . import memory  # noqa: PLC0415

        return " ".join(str(memory.relevant(task, "takeover") or "").split())[:MEMORY_CHARS]
    except Exception:  # noqa: BLE001  (memory is optional: the prompt is still good without it)
        return ""


def build_prompt(task: str, ctx: str = "") -> str:
    """A complete, specific prompt: role, goal, context, how to work (ask first, plan, then deliver in parts)."""
    task = re.sub(r"^\s*task\s*:\s*", "", " ".join(task.split()), flags=re.I)
    task = ASK_RE.sub(lambda m: "", task).strip(" ,.") or task  # "ask claude to ..." -> the AI is already chosen
    task = re.sub(r"^(?:to|and)\s+", "", task, flags=re.I)
    role = next((r for rx, r in ROLES if rx.search(task)), "senior expert in this field")
    parts = [
        f"Act as a {role}. This is my goal:",
        task[0].upper() + task[1:] if task else task,
    ]
    if ctx:
        parts += ["", "What you should know about me and my company:", ctx]
    parts += [
        "",
        "How I want you to work:",
        "1. First ask me up to 5 short, specific questions you need answered (audience, style, budget, deadline, must-have features), all in one message, and wait for my answers.",
        "2. Then give me a clear step-by-step plan.",
        "3. Then deliver the real work (complete, ready-to-use code or text, not outlines), one part at a time, so I can check each part before you continue.",
        "Keep it practical, in plain language, and tell me what you assumed.",
    ]
    return "\n".join(parts)[:MAX_PROMPT]


def _reg(raw: dict) -> dict:
    w, h = hands.screen_size()
    action = hands.normalize_action(raw, (w, h), hands._pg().KEYBOARD_KEYS, allow_fs=True)  # allow_fs also admits the paste action
    return hands.register(action)


def check(instruction) -> dict:
    if not isinstance(instruction, str):
        raise RequestError(INVALID_PAYLOAD, "'instruction' must be text.")
    return {"big": is_big(instruction), "ai": named_ai(instruction), "ais": [{"key": k, "label": v[0]} for k, v in AIS.items()]}


def plan(instruction, ai) -> dict:
    hands._check_stopped()
    if not isinstance(instruction, str) or not instruction.strip():
        raise RequestError(INVALID_PAYLOAD, "'instruction' must be non-empty text.")
    key = key_for(ai)
    if not key:
        raise RequestError(INVALID_PAYLOAD, "'ai' must be one of: " + ", ".join(AIS) + ".")
    label, url = AIS[key]
    prompt = build_prompt(instruction, _context(instruction))
    raws = [
        {"type": "hotkey", "keys": ["win", "r"]},
        {"type": "type", "text": f'chrome --profile-directory="{CHROME_PROFILE}" {url}' if CHROME_PROFILE else url},
        {"type": "press", "key": "enter"},
        {"type": "wait", "seconds": PAGE_WAIT},
        {"type": "paste", "text": prompt},
        {"type": "wait", "seconds": 0.4},
        {"type": "press", "key": "enter"},
    ]
    steps = [_reg(r) for r in raws]
    log.info("delegating to %s: %d steps, prompt %d chars", label, len(steps), len(prompt))
    return {"ai": key, "label": label, "prompt": prompt, "steps": steps}

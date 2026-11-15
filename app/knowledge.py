"""What FIDEX AI knows about itself. Added to the prompt ONLY when the question is about the app (keeps normal chat fast)."""
from __future__ import annotations

import re

APP_FACTS = (
    "FIDEX AI facts (answer app questions from these only; never invent features):\n"
    "- FIDEX AI is a personal executive-agent desktop app for Windows. It runs a local AI (Ollama, qwen3.5:4b), offline, private. Parts: Brain (thinks/plans), Hands (mouse, keyboard, opens apps, files through PyAutoGUI), Eye (Vision: looks at the screen), Memory (SQLite on this device).\n"
    "- Sidebar: New chat, Take Over, Start Solving World Problems, Guide Me, Give Me Your Details, How to Use, History, Permissions, Settings, About. Recent chats are listed too.\n"
    "- Chat: normal conversation, streamed live. The Send button becomes Stop while it writes. Type /memory to see, edit or delete everything remembered. Ask about earlier chats and it searches saved conversations.\n"
    "- Take Over: type a task on Home or the Take Over page and press send. The full window hides; a small logo circle and an activity panel remain. Click the circle to show/hide the panel; the open button or tray icon brings the full window back. FIDEX AI does the work with Hands (clicks, types, opens apps, creates folders/files), shows each step live, asks in the panel only when a needed fact is missing, and you can add instructions anytime. Consequential actions (publishing, sending messages, spending money, deleting files, external commitments) always wait for your approval in the panel. Interrupted tasks show as 'Interrupted' in recent assignments/History; click to continue.\n"
    "- Start Solving World Problems: describe a problem, pick a focus (Health, Climate, Jobs, Advertisement, Others), press Start research. It searches the web, reads pages, shows steps live, then gives findings, causes, solution options, a recommendation and a plan. Needs internet and the AI engine. Stop research cancels it.\n"
    "- Guide Me: say a goal; it makes ordered steps you tick off, saves progress, and lets you resume later.\n"
    "- Give Me Your Details: optional personal/professional details saved on this device and added to memory so answers fit you. Do not enter passwords or card numbers. Use 'Remove my details' to delete.\n"
    "- Permissions page: switches for Microphone (voice dictation in chat), Screen (lets the Eye see your screen when asked), Browser (open links, notifications), Files (only files/folders you pick). Each switch is your consent; Windows may still ask or block. Reset restores defaults.\n"
    "- Settings: 'Open the Take Over panel after assigning' (hide the window and show circle + panel), 'Keep the panel on top' (float above other windows), Clear conversations, Clear Take Over history, Show welcome screen.\n"
    "- History: all saved chats and Take Over assignments; open or delete any.\n"
    "- Vision/Eye: describe or answer about the screen on request; it never slows normal chat.\n"
    "- Fixes: if replies fail, start Ollama (open the Ollama app or run 'ollama serve') and run 'ollama pull qwen3.5:4b' once.\n"
)

APP_STYLE = "This is a question about using FIDEX AI: give clear numbered steps or a short explanation (up to 6 short lines), plain text, naming the exact buttons and pages."

_ASKS = re.compile(
    r"\b(fidex|take ?over|world problems?|guide me|how (do|can|to) i (use|start|assign|set|turn|change|stop|resume|delete|clear|give)|how to use|how does (this|it|the app) work|"
    r"(what|which) (can|do) you (do|know)|your (features?|abilities|capabilities|modes?|tools|hands|eye|brain)|what (are|is) (the )?(permissions?|settings?|vision|hands|brain|memory|history|profile)|"
    r"permissions?|settings?|the (circle|activity panel|panel|tray)|give me your details|my details|/memory|"
    r"(help|guide|teach|show) me (to )?(use|with this|with the app|how)|getting started|get started|tutorial|features?)\b", re.I)


def wants_app_facts(question: str) -> bool:
    return bool(_ASKS.search(question or ""))

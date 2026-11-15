# Run from the folder that contains the backend package:  python verify_mouse.py
# Goes through the real hands.py (register -> approval gate -> approve -> execute) and moves the REAL mouse.
import time
from backend import hands
hands.start()
w, h = hands.screen_size()
act = hands.register(hands.normalize_action({"type": "move", "x": w // 2, "y": h // 2}, (w, h), hands._pg().KEYBOARD_KEYS))
print("screen", w, h, "| planned:", act["describe"])
r = hands.execute(act["id"])
print("RESULT:", "SUCCESS" if r["ok"] else "FAILED", r.get("detail") or r.get("error"))

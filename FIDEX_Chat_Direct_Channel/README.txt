FIDEX AI - Direct Chat Channel update (apply AFTER the Fast Chat Engine update)

1. Close FIDEX AI completely (also from the tray).
2. Extract this ZIP into your FIDEX AI project folder (the one with "app", "js", renderer.js). Replace files:
     app/ai.py     (memory context cached, no SQLite wait on the chat path)
     renderer.js   (request sent first, deferred saving, partial answers kept)
3. Start FIDEX AI.

# FIDEX AI V1 - removal of old features (renderer + electron)

Kept: Chat, Give Me Your Details, History (conversations), How to Use, About, welcome screen.
Chat is now the default screen after the welcome screen (router default + first view).

## Modified (extract over the project)
- src/renderer/index.html - removed Home/Assign, Take Over, World Problems, Guide Me, Permissions, Settings views; History tabs for assignments; unused icons and home.css link; How to Use and About text rewritten for the remaining features.
- src/renderer/renderer.js - removed all imports, state, handlers and wiring for the removed features (assignments, overlay events, settings, unfinished-task restore, vision card).
- src/renderer/js/router.js - default view is now chat.
- src/renderer/js/history.js - conversations only.
- src/renderer/js/storage.js - removed assignments, settings, permissions, Guide plans and research storage (profile and conversations unchanged).
- src/renderer/js/bridge.js - removed overlay (Take Over window) calls.
- src/renderer/js/responder.js - removed getAgentContext (Take Over / Guide only).
- src/renderer/js/first-run.js - removed the "See start" button listener (Settings button no longer exists).
- src/renderer/views.css, v09.css, workspace.css - removed styles for removed pages; class world-form renamed pf-panel (still used by the details form).

## Deleted (delete these from your project; see DELETED_FILES.txt)
overlay.html, overlay.css, home.css, js/overlay.js, takeover.js, world.js, guide.js, permissions.js, settings.js, commandbox.js, agent-core.js, agent-sim.js, agent-ai.js, hands-agent.js (+4 backup copies), progress-saver.js, progress-map.js, resume.js, vision-panel.js, stream.js.

## Verified
All JS files pass a syntax check; every import resolves; every element id used by the scripts exists in index.html.

## Not touched / notes
- src/preload/preload.js and the Python backend were not in the ZIP; preload.js likely still exposes overlay:* channels (now unregistered in main.js) - harmless but should be cleaned.
- Root-level src/renderer/first-run.js, intro-3d.js, intro-image.js, intro-font.js, intro-image.css and js/intro-*.js, js/gen-images.js are not loaded by index.html; left alone as unrelated.
- Old saved localStorage keys (fidex.takeover.v1, fidex.settings.v1, fidex.permissions.v1, fidex.guide.v1, fidex.research.v1) are simply ignored.
- Not run in Electron; I only could syntax/dependency check.

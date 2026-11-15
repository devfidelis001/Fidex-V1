# Step 6: Automatic save progress

Saved in SQLite as changes happen; restored after a restart. No interface redesign.

## What is saved (schema v2, additive migration, old data untouched)
- `tasks` gains `progress`, `phase`, `instruction`, `activity`, `interrupted_at`.
- `task_steps`: completed / active / pending steps. `task_requests`: questions and approvals (with `executed_at`).
- `work_context`: project, instructions, decisions, files, activities, notes (de-duplicated by content hash).
- `app_sessions`: tells a clean exit from a crash.

## Backend requests (`backend/app/progress.py`, `storage_handlers.py`)
`work.save` (one transaction, idempotent upsert), `work.restore` (read-only), `work.resume`, `work.discard`, `work.context.add`.

## Safety rules
- One transaction per save: a crash leaves the previous saved state intact.
- Same ids / same content never create duplicates. Progress, step state and answered questions only move forward; finished tasks are never revived by a late save.
- Restoring never runs anything. Resuming reopens approvals that were given but not recorded as executed, so the user approves again; executed actions are never offered again.
- The report says when it was last saved and that anything after that point was not saved. Tasks that were running but never reached the database are shown as "Interrupted, progress not saved", never as recovered.

## Interface
Unchanged layout. The Take Over panel saves automatically (`progress-saver.js`). On start the recent-assignments list shows "Interrupted: click to continue"; clicking reopens the panel at the saved step (`agent-sim.js` `resume`).

## Tests
`backend/tests/test_progress.py`, `tests/node/progress-save.test.js`.

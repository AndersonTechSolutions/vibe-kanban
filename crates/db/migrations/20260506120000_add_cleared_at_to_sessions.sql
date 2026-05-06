-- Adds a per-session `cleared_at` timestamp marking the boundary at which a
-- user-triggered "Clear context" action wiped the resume linkage.
--
-- The column is purely a marker: prior coding_agent_turns and
-- execution_processes remain visible in the timeline. Resume-lookup queries
-- filter on `created_at > cleared_at` so the next user message spawns a cold
-- executor session instead of resuming the pre-clear thread.
--
-- Nullable; existing rows default to NULL (no clear ever performed).

ALTER TABLE sessions ADD COLUMN cleared_at TIMESTAMP NULL;

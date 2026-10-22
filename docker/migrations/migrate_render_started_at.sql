-- Apply to existing databases only. Fresh databases get this field from _init.sql.
-- When a render node started rendering a video, used to show how long the render took.
ALTER TABLE videos
    ADD COLUMN render_started_at TIMESTAMP NULL AFTER rendered_at;

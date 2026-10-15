-- Apply to existing databases only. Fresh databases get this field from _init.sql.
-- Bitmask of board sources a render node may render (bit = 1 << board_source),
-- 15 = requested renders, Portal 2 board, Mel board and LP Hub.
-- Render priority per board source (comma separated, indexed by board_source),
-- 1 is rendered first, equal values have no preference.
ALTER TABLE access_tokens
    ADD COLUMN render_sources INT NOT NULL DEFAULT 15 AFTER permissions,
    ADD COLUMN render_priorities VARCHAR(32) NOT NULL DEFAULT '1,1,1,1' AFTER render_sources;

-- Apply to existing databases only. Fresh databases get this field from _init.sql.
ALTER TABLE videos
    ADD COLUMN board_map_id BIGINT NULL AFTER board_demo_id;

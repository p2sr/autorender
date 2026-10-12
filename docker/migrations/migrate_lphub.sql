-- Apply to existing databases only. Fresh databases get these fields from _init.sql.
ALTER TABLE videos
    ADD COLUMN board_demo_id VARCHAR(64) NULL AFTER board_changelog_id,
    ADD UNIQUE KEY(board_source, board_demo_id),
    MODIFY COLUMN board_source_domain VARCHAR(32)
        AS (
            IF(
                board_source = 0,
                NULL,
                IF(
                    board_source = 1,
                    'board.portal2.sr',
                    IF(board_source = 2, 'mel.portal2.jonesy.moe', 'lp.portal2.sr')
                )
            )
        ) STORED;

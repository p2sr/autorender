-- Apply to existing databases only. Fresh databases get these from _init.sql.
-- Site-wide settings changed by admins (e.g. pausing renders).
CREATE TABLE IF NOT EXISTS settings (
    name VARCHAR(64) NOT NULL,
    value VARCHAR(1024) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (name)
);

-- Videos with a higher queue priority are rendered first ("move to front").
ALTER TABLE videos
    ADD COLUMN queue_priority INT NOT NULL DEFAULT 0 AFTER pending;

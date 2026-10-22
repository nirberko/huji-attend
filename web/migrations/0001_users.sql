-- One row per connected Moodle account (token obtained from the profile QR).
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site          TEXT    NOT NULL,
  moodle_userid INTEGER NOT NULL,
  token         TEXT    NOT NULL,
  private_token TEXT    NOT NULL,
  fullname      TEXT,
  username      TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site, moodle_userid)
);

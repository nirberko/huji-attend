-- Moodle browser session (JSON cookie jar) saved after an autologin, so later scans can
-- skip tool_mobile_get_autologin_key (rate-limited to one key per user every ~6 min).
ALTER TABLE users ADD COLUMN session_cookies TEXT;

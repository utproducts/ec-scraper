-- Migration: add extended batting stat columns to ec_game_stats
-- Adds HR, SB, doubles (2B), triples (3B) so the leaderboards can rank them.
-- Safe to run multiple times (IF NOT EXISTS). Run in the Supabase SQL editor.
--
-- After running this, re-scrape events (or let the live poller re-save games)
-- so the new columns get populated from GameChanger's box-score JSON.

-- Batting
ALTER TABLE ec_game_stats ADD COLUMN IF NOT EXISTS hr      integer NOT NULL DEFAULT 0;
ALTER TABLE ec_game_stats ADD COLUMN IF NOT EXISTS sb      integer NOT NULL DEFAULT 0;
ALTER TABLE ec_game_stats ADD COLUMN IF NOT EXISTS doubles integer NOT NULL DEFAULT 0;
ALTER TABLE ec_game_stats ADD COLUMN IF NOT EXISTS triples integer NOT NULL DEFAULT 0;

-- Pitching (decision stats)
ALTER TABLE ec_game_stats ADD COLUMN IF NOT EXISTS wins    integer NOT NULL DEFAULT 0;
ALTER TABLE ec_game_stats ADD COLUMN IF NOT EXISTS saves   integer NOT NULL DEFAULT 0;

-- Optional: index to speed up leaderboard scans by stat type
CREATE INDEX IF NOT EXISTS idx_ec_game_stats_type ON ec_game_stats (stat_type);

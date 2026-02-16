-- ═══════════════════════════════════════════════════════════════
-- EVENT CENTRAL SaaS Migration
-- Run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- 1. Events table — each tournament/event a director creates
CREATE TABLE IF NOT EXISTS ec_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  venue TEXT,
  age_groups TEXT[] DEFAULT '{}',  -- e.g. {'11U', '12U', '14U'}
  director_id UUID,  -- links to directors table if we have one
  director_name TEXT,
  director_email TEXT,
  director_phone TEXT,
  status TEXT DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'scraping', 'complete', 'archived')),
  scraper_status TEXT DEFAULT 'stopped' CHECK (scraper_status IN ('stopped', 'running', 'error')),
  last_scraped_at TIMESTAMPTZ,
  game_count INTEGER DEFAULT 0,
  invoice_amount DECIMAL(10,2) DEFAULT 0,
  invoice_status TEXT DEFAULT 'pending' CHECK (invoice_status IN ('pending', 'sent', 'paid')),
  stripe_invoice_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Event team links — GC URLs for each team in an event
CREATE TABLE IF NOT EXISTS ec_event_teams (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES ec_events(id) ON DELETE CASCADE,
  gc_team_url TEXT NOT NULL,
  age_group TEXT NOT NULL,
  team_name TEXT, -- populated after first scrape
  team_id UUID REFERENCES ec_teams(id),
  gc_team_id TEXT, -- extracted from URL
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'error')),
  last_scraped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Add event_id to existing tables
ALTER TABLE ec_teams ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES ec_events(id);
ALTER TABLE ec_games ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES ec_events(id);
ALTER TABLE ec_players ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES ec_events(id);

-- 4. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_ec_events_slug ON ec_events(slug);
CREATE INDEX IF NOT EXISTS idx_ec_events_status ON ec_events(status);
CREATE INDEX IF NOT EXISTS idx_ec_event_teams_event_id ON ec_event_teams(event_id);
CREATE INDEX IF NOT EXISTS idx_ec_games_event_id ON ec_games(event_id);
CREATE INDEX IF NOT EXISTS idx_ec_teams_event_id ON ec_teams(event_id);
CREATE INDEX IF NOT EXISTS idx_ec_players_event_id ON ec_players(event_id);

-- 5. Florida Rankings view — aggregates player stats across all events
CREATE OR REPLACE VIEW ec_florida_player_rankings AS
SELECT 
  p.id as player_id,
  p.player_name,
  p.jersey_number,
  t.team_name,
  t.age_group,
  COUNT(DISTINCT s.game_id) as games_played,
  SUM(CASE WHEN s.stat_type = 'batting' THEN s.ab ELSE 0 END) as total_ab,
  SUM(CASE WHEN s.stat_type = 'batting' THEN s.r ELSE 0 END) as total_r,
  SUM(CASE WHEN s.stat_type = 'batting' THEN s.h ELSE 0 END) as total_h,
  SUM(CASE WHEN s.stat_type = 'batting' THEN s.rbi ELSE 0 END) as total_rbi,
  SUM(CASE WHEN s.stat_type = 'batting' THEN s.bb ELSE 0 END) as total_bb,
  SUM(CASE WHEN s.stat_type = 'batting' THEN s.so ELSE 0 END) as total_so,
  CASE 
    WHEN SUM(CASE WHEN s.stat_type = 'batting' THEN s.ab ELSE 0 END) > 0 
    THEN ROUND(SUM(CASE WHEN s.stat_type = 'batting' THEN s.h ELSE 0 END)::numeric / 
         SUM(CASE WHEN s.stat_type = 'batting' THEN s.ab ELSE 0 END)::numeric, 3)
    ELSE 0 
  END as batting_avg,
  SUM(CASE WHEN s.stat_type = 'pitching' THEN s.ip ELSE 0 END) as total_ip,
  SUM(CASE WHEN s.stat_type = 'pitching' THEN s.p_so ELSE 0 END) as total_k,
  SUM(CASE WHEN s.stat_type = 'pitching' THEN s.p_bb ELSE 0 END) as total_p_bb,
  SUM(CASE WHEN s.stat_type = 'pitching' THEN s.p_er ELSE 0 END) as total_er
FROM ec_players p
JOIN ec_teams t ON p.team_id = t.id
JOIN ec_game_stats s ON s.player_id = p.id
GROUP BY p.id, p.player_name, p.jersey_number, t.team_name, t.age_group;

-- 6. Team rankings view
CREATE OR REPLACE VIEW ec_florida_team_rankings AS
SELECT 
  t.id as team_id,
  t.team_name,
  t.age_group,
  COUNT(DISTINCT g.id) as games_played,
  SUM(CASE 
    WHEN (g.away_team_id = t.id AND g.away_score > g.home_score) OR 
         (g.home_team_id = t.id AND g.home_score > g.away_score) 
    THEN 1 ELSE 0 
  END) as wins,
  SUM(CASE 
    WHEN (g.away_team_id = t.id AND g.away_score < g.home_score) OR 
         (g.home_team_id = t.id AND g.home_score < g.away_score) 
    THEN 1 ELSE 0 
  END) as losses,
  SUM(CASE WHEN g.away_team_id = t.id THEN g.away_score ELSE g.home_score END) as runs_scored,
  SUM(CASE WHEN g.away_team_id = t.id THEN g.home_score ELSE g.away_score END) as runs_allowed
FROM ec_teams t
JOIN ec_games g ON t.id = g.away_team_id OR t.id = g.home_team_id
WHERE t.team_name NOT LIKE 'TBD%'
GROUP BY t.id, t.team_name, t.age_group;

-- 7. Update existing games with a default event (Space Coast Presidents Day)
-- Run this AFTER creating the event via the dashboard
-- UPDATE ec_games SET event_id = '<event-uuid>' WHERE event_id IS NULL;
-- UPDATE ec_teams SET event_id = '<event-uuid>' WHERE event_id IS NULL;
-- UPDATE ec_players SET event_id = '<event-uuid>' WHERE event_id IS NULL;

-- 8. Enable RLS (Row Level Security) - optional for now
-- ALTER TABLE ec_events ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE ec_event_teams ENABLE ROW LEVEL SECURITY;

SELECT 'Migration complete! Tables created: ec_events, ec_event_teams. Columns added: event_id on ec_teams, ec_games, ec_players. Views created: ec_florida_player_rankings, ec_florida_team_rankings.' as result;

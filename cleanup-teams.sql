-- Clean up duplicate teams in Supabase
-- Run this in the Supabase SQL Editor

-- Step 1: See all teams
SELECT id, team_name FROM ec_teams ORDER BY team_name;

-- Step 2: Merge "Ballplex Bolts 11U" into "Ballplex Academy 11U"
UPDATE ec_game_stats SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Academy 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U');

UPDATE ec_games SET away_team_id = (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Academy 11U' LIMIT 1)
WHERE away_team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U');

UPDATE ec_games SET home_team_id = (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Academy 11U' LIMIT 1)
WHERE home_team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U');

UPDATE ec_players SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Academy 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U');

UPDATE ec_player_of_game SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Academy 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U');

DELETE FROM ec_teams WHERE team_name = 'Ballplex Bolts 11U';

-- Step 3: Merge "Warriors 11U" into "Warriors Baseball Club Orange 11U"
UPDATE ec_game_stats SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Warriors Baseball Club Orange 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Warriors 11U');

UPDATE ec_games SET away_team_id = (SELECT id FROM ec_teams WHERE team_name = 'Warriors Baseball Club Orange 11U' LIMIT 1)
WHERE away_team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Warriors 11U');

UPDATE ec_games SET home_team_id = (SELECT id FROM ec_teams WHERE team_name = 'Warriors Baseball Club Orange 11U' LIMIT 1)
WHERE home_team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Warriors 11U');

UPDATE ec_players SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Warriors Baseball Club Orange 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Warriors 11U');

UPDATE ec_player_of_game SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'Warriors Baseball Club Orange 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name = 'Warriors 11U');

DELETE FROM ec_teams WHERE team_name = 'Warriors 11U';

-- Step 4: Merge TC ELITE variants into "TC ELITE 11U"
UPDATE ec_game_stats SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'TC ELITE 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U'));

UPDATE ec_games SET away_team_id = (SELECT id FROM ec_teams WHERE team_name = 'TC ELITE 11U' LIMIT 1)
WHERE away_team_id IN (SELECT id FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U'));

UPDATE ec_games SET home_team_id = (SELECT id FROM ec_teams WHERE team_name = 'TC ELITE 11U' LIMIT 1)
WHERE home_team_id IN (SELECT id FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U'));

UPDATE ec_players SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'TC ELITE 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U'));

UPDATE ec_player_of_game SET team_id = (SELECT id FROM ec_teams WHERE team_name = 'TC ELITE 11U' LIMIT 1)
WHERE team_id IN (SELECT id FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U'));

DELETE FROM ec_teams WHERE team_name IN ('tc elite 11u', 'TC ELITE 11U 11U');

-- Step 5: Check what's left
SELECT id, team_name FROM ec_teams ORDER BY team_name;

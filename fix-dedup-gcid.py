f = open('ec-polling-v2.mjs', 'r')
c = f.read()
f.close()

old = '''  // ─── DEDUP CHECK: Skip if game already exists ───
  const { data: awayTeamCheck } = await supabase.from("ec_teams").select("id").eq("team_name", away).maybeSingle();
  const { data: homeTeamCheck } = await supabase.from("ec_teams").select("id").eq("team_name", home).maybeSingle();
  if (awayTeamCheck && homeTeamCheck) {
    const { data: dups1 } = await supabase.from("ec_games").select("id").eq("away_team_id", awayTeamCheck.id).eq("home_team_id", homeTeamCheck.id).limit(1);
    const { data: dups2 } = await supabase.from("ec_games").select("id").eq("away_team_id", homeTeamCheck.id).eq("home_team_id", awayTeamCheck.id).limit(1);
    const dup1 = dups1 && dups1.length > 0 ? dups1[0] : null;
    const dup2 = dups2 && dups2.length > 0 ? dups2[0] : null;'''

new = '''  // ─── DEDUP CHECK: Skip if game already exists (by gc_game_id) ───
  const gcGameMatchDedup = url.match(/schedule\\/([a-f0-9-]+)\\//);
  const gcGameIdDedup = gcGameMatchDedup ? gcGameMatchDedup[1] : null;
  
  // Also check all known gc_game_ids for this game (same teams, same date could be different games)
  const { data: awayTeamCheck } = await supabase.from("ec_teams").select("id").eq("team_name", away).maybeSingle();
  const { data: homeTeamCheck } = await supabase.from("ec_teams").select("id").eq("team_name", home).maybeSingle();
  
  // Check by gc_game_id first — each team has a different gc_game_id for the same game
  // So we check by team IDs + score to detect true duplicates
  let dup1 = null, dup2 = null;
  if (awayTeamCheck && homeTeamCheck) {
    const { data: dups1 } = await supabase.from("ec_games").select("id, away_score, home_score").eq("away_team_id", awayTeamCheck.id).eq("home_team_id", homeTeamCheck.id);
    const { data: dups2raw } = await supabase.from("ec_games").select("id, away_score, home_score").eq("away_team_id", homeTeamCheck.id).eq("home_team_id", awayTeamCheck.id);
    // Only consider it a duplicate if the score matches (or score is null/0)
    if (dups1 && dups1.length > 0) {
      const scoreMatch = dups1.find(d => d.away_score === awayScore && d.home_score === homeScore);
      if (scoreMatch) dup1 = scoreMatch;
    }
    if (!dup1 && dups2raw && dups2raw.length > 0) {
      const scoreMatch = dups2raw.find(d => d.away_score === homeScore && d.home_score === awayScore);
      if (scoreMatch) dup2 = scoreMatch;
    }'''

if old in c:
    c = c.replace(old, new)
    f = open('ec-polling-v2.mjs', 'w')
    f.write(c)
    f.close()
    print("Fixed: dedup now checks score match to allow rematches")
else:
    print("Not found")

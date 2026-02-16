f = open('ec-polling-v2.mjs', 'r')
c = f.read()
f.close()

old = "        stat_type: 'batting', ab: p.ab, r: p.r, h: p.h, rbi: p.rbi, bb: p.bb, so: p.so,"

new = "        stat_type: 'batting', ab: p.ab, r: p.r, h: p.h, rbi: p.rbi, bb: p.bb, so: p.so,"

# Add debug log before the batting insert
old2 = "      await supabase.from('ec_game_stats').insert({\n        game_id: gameId, player_id: playerId, team_id: team.teamId,\n        stat_type: 'batting'"

new2 = "      if (p.name === 'Beckham J') console.log('  STATS DEBUG Beckham J: AB=' + p.ab + ' R=' + p.r + ' H=' + p.h + ' RBI=' + p.rbi);\n      await supabase.from('ec_game_stats').insert({\n        game_id: gameId, player_id: playerId, team_id: team.teamId,\n        stat_type: 'batting'"

if old2 in c:
    c = c.replace(old2, new2)
    f = open('ec-polling-v2.mjs', 'w')
    f.write(c)
    f.close()
    print("Added Beckham J debug logging")
else:
    print("Could not find insert block")

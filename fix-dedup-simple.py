f = open('ec-polling-v2.mjs', 'r')
lines = f.readlines()
f.close()

# Find the dedup check section and replace with simple skip
new_lines = []
in_dedup = False
dedup_done = False

for i, line in enumerate(lines):
    if 'DEDUP CHECK' in line and 'END' not in line and not dedup_done:
        in_dedup = True
        new_lines.append('  // ─── DEDUP CHECK: Skip if game already exists ───\n')
        new_lines.append('  const { data: awayTeamCheck } = await supabase.from("ec_teams").select("id").eq("team_name", away).single();\n')
        new_lines.append('  const { data: homeTeamCheck } = await supabase.from("ec_teams").select("id").eq("team_name", home).single();\n')
        new_lines.append('  if (awayTeamCheck && homeTeamCheck) {\n')
        new_lines.append('    const { data: dup1 } = await supabase.from("ec_games").select("id").eq("away_team_id", awayTeamCheck.id).eq("home_team_id", homeTeamCheck.id).limit(1).single();\n')
        new_lines.append('    const { data: dup2 } = await supabase.from("ec_games").select("id").eq("away_team_id", homeTeamCheck.id).eq("home_team_id", awayTeamCheck.id).limit(1).single();\n')
        new_lines.append('    if (dup1 || dup2) {\n')
        new_lines.append('      console.log("  SKIP duplicate: " + away + " vs " + home);\n')
        new_lines.append('      return dup1 ? dup1.id : dup2.id;\n')
        new_lines.append('    }\n')
        new_lines.append('  }\n')
        continue
    if in_dedup:
        if 'END DEDUP CHECK' in line:
            in_dedup = False
            dedup_done = True
            new_lines.append('  // ─── END DEDUP CHECK ───\n')
        continue
    
    # Also remove the existingGameId stats cleanup block
    if 'If game already existed, delete old stats' in line:
        continue
    if line.strip() == '{' and i > 0 and 'already existed' in lines[i-1]:
        continue
    
    new_lines.append(line)

f = open('ec-polling-v2.mjs', 'w')
f.writelines(new_lines)
f.close()
print("Done - simple dedup: skip if game exists")

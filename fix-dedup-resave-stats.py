f = open('ec-polling-v2.mjs', 'r')
c = f.read()
f.close()

old = '''      } else {
        console.log("  SKIP duplicate: " + away + " vs " + home);
      }
      return dupId;
    }
  }
  // ─── END DEDUP CHECK ───'''

new = '''      } else {
        console.log("  SKIP duplicate: " + away + " vs " + home);
      }
      // Re-save stats for BOTH teams with current scrape data (more accurate)
      if (tables.length >= 4) {
        const awayBat = parseBatting(tables[0]);
        const awayPit = parsePitching(tables[1]);
        const homeBat = parseBatting(tables[2]);
        const homePit = parsePitching(tables[3]);
        const aTeamId = awayTeamCheck.id;
        const hTeamId = homeTeamCheck.id;
        // Flip if teams were stored in opposite order
        const [t1Id, t1Bat, t1Pit, t2Id, t2Bat, t2Pit] = dup1
          ? [aTeamId, awayBat, awayPit, hTeamId, homeBat, homePit]
          : [hTeamId, homeBat, homePit, aTeamId, awayBat, awayPit];
        // Clear old stats
        await supabase.from("ec_game_stats").delete().eq("game_id", dupId);
        await supabase.from("ec_player_of_game").delete().eq("game_id", dupId);
        // Re-save
        for (const team of [{b:t1Bat,p:t1Pit,tid:t1Id},{b:t2Bat,p:t2Pit,tid:t2Id}]) {
          for (const pl of team.b) {
            const pid = await findOrCreatePlayer(pl.name, pl.jersey, team.tid);
            if (!pid) continue;
            await supabase.from("ec_game_stats").insert({
              game_id: dupId, player_id: pid, team_id: team.tid,
              stat_type: "batting", ab: pl.ab, r: pl.r, h: pl.h, rbi: pl.rbi, bb: pl.bb, so: pl.so,
              position_played: pl.pos,
            });
          }
          for (const pl of team.p) {
            const pid = await findOrCreatePlayer(pl.name, pl.jersey, team.tid);
            if (!pid) continue;
            await supabase.from("ec_game_stats").insert({
              game_id: dupId, player_id: pid, team_id: team.tid,
              stat_type: "pitching", ip: pl.ip, p_h: pl.h, p_r: pl.r, p_er: pl.er, p_bb: pl.bb, p_so: pl.so,
            });
          }
        }
        await calculatePOTG(dupId);
        console.log("  🔄 Re-saved stats from current scrape");
      }
      return dupId;
    }
  }
  // ─── END DEDUP CHECK ───'''

if old in c:
    c = c.replace(old, new)
    f = open('ec-polling-v2.mjs', 'w')
    f.write(c)
    f.close()
    print("Fixed: dedup now re-saves stats")
else:
    print("Not found")

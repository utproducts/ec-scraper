f = open('ec-polling-v2.mjs', 'r')
c = f.read()
f.close()

old = '''    if (dup1 || dup2) {
      console.log("  SKIP duplicate: " + away + " vs " + home);
      return dup1 ? dup1.id : dup2.id;
    }
  }'''

new = '''    if (dup1 || dup2) {
      const dupId = dup1 ? dup1.id : dup2.id;
      if (awayScore !== null && homeScore !== null) {
        const upd = dup1
          ? { away_score: awayScore, home_score: homeScore }
          : { away_score: homeScore, home_score: awayScore };
        await supabase.from("ec_games").update(upd).eq("id", dupId);
        console.log("  SKIP dup (score updated): " + away + " " + awayScore + " vs " + home + " " + homeScore);
      } else {
        console.log("  SKIP duplicate: " + away + " vs " + home);
      }
      return dupId;
    }
  }'''

if old in c:
    c = c.replace(old, new)
    f = open('ec-polling-v2.mjs', 'w')
    f.write(c)
    f.close()
    print("Fixed")
else:
    print("Not found")

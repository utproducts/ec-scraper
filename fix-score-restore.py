f = open('ec-polling-v2.mjs', 'r')
c = f.read()
f.close()

old = '      if (awayScoreEl) awayScore = parseInt(awayScoreEl.innerText.trim());\n      if (homeScoreEl) homeScore = parseInt(homeScoreEl.innerText.trim());\n      if (isNaN(awayScore)) awayScore = null;\n      if (isNaN(homeScore)) homeScore = null;\n      console.log("  SCORE DEBUG: awayScoreEl=" + (awayScoreEl ? "found" : "MISSING") + " homeScoreEl=" + (homeScoreEl ? "found" : "MISSING") + " awayScore=" + awayScore + " homeScore=" + homeScore);'

new = '      if (awayScoreEl) awayScore = parseInt(awayScoreEl.innerText.trim()) || null;\n      if (homeScoreEl) homeScore = parseInt(homeScoreEl.innerText.trim()) || null;'

if old in c:
    c = c.replace(old, new)
    print("Restored header parsing")
else:
    print("Header block not found - checking alt")

old2 = "finalAwayScore = null;\n  let finalHomeScore = null;"
if old2 in c:
    # Find and replace the entire score block
    start = c.index("// Score priority")
    end = c.index("homeBatting.reduce((s, p) => s + p.r, 0);") + len("homeBatting.reduce((s, p) => s + p.r, 0);")
    c = c[:start] + "const finalAwayScore = awayScore !== null ? awayScore : awayBatting.reduce((s, p) => s + p.r, 0);\n  const finalHomeScore = homeScore !== null ? homeScore : homeBatting.reduce((s, p) => s + p.r, 0);" + c[end:]
    print("Restored score logic")
else:
    print("Score block not found")

f = open('ec-polling-v2.mjs', 'w')
f.write(c)
f.close()

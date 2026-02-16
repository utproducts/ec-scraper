f = open('ec-polling-v2.mjs', 'r')
lines = f.readlines()
f.close()
lines[299] = "    await sleep(6000);\n"
f = open('ec-polling-v2.mjs', 'w')
f.writelines(lines)
f.close()
print("Changed box score wait from 3s to 6s")

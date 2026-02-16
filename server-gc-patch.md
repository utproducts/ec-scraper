# Server.js GC Link Auto-Match Patch

## Problem
When a coach texts back their GC link, the server auto-matches by phone number but only searches the OLD `teams` table. Your 84 teams are in `ec_teams`. Also, even when matched, it only updates `gamechanger_links` — never sets `ec_teams.gc_team_id`, which the scraper needs.

## Fix
In `server.js`, find the GC link detection section (search for `Auto-match to team by phone number` or `from('teams')` near the GC link code).

Replace this block:
```javascript
      // Auto-match to team by phone number
      const cleanPhone = From.replace(/\D/g, '').slice(-10);
      const { data: matchedTeams } = await supabase
        .from('teams')
        .select('id, name, age_group, event_id, coach_phone')
        .order('created_at', { ascending: false });
```

With this:
```javascript
      // Auto-match to team by phone number — search ec_teams (primary) AND legacy teams
      const cleanPhone = From.replace(/\D/g, '').slice(-10);
      
      // Search ec_teams first (where CSV-uploaded teams live)
      const { data: ecTeamsMatch } = await supabase
        .from('ec_teams')
        .select('id, team_name, coach_phone, age_group');
      const { data: ecEventTeams } = await supabase
        .from('ec_event_teams')
        .select('team_id, event_id, age_group');
      
      // Also search legacy teams table
      const { data: legacyTeams } = await supabase
        .from('teams')
        .select('id, name, age_group, event_id, coach_phone')
        .order('created_at', { ascending: false });
      
      // Build combined search list
      const allSearchTeams = [];
      (ecTeamsMatch || []).forEach(t => {
        const etLink = (ecEventTeams || []).find(et => et.team_id === t.id);
        allSearchTeams.push({
          id: t.id, name: t.team_name, coach_phone: t.coach_phone,
          age_group: etLink?.age_group || t.age_group || '',
          event_id: etLink?.event_id || '', source: 'ec_teams'
        });
      });
      (legacyTeams || []).forEach(t => {
        allSearchTeams.push({
          id: t.id, name: t.name, coach_phone: t.coach_phone,
          age_group: t.age_group || '', event_id: t.event_id || '', source: 'teams'
        });
      });
      
      const matchedTeams = allSearchTeams;
```

Then, right AFTER the `gamechanger_links` update (the part that sets `status: 'matched'`), add:
```javascript
          // ALSO update ec_teams.gc_team_id so the scraper knows about this link
          if (match.source === 'ec_teams') {
            await supabase.from('ec_teams').update({
              gc_team_id: gcTeamId,
              gc_team_link: gcUrl
            }).eq('id', match.id);
            console.log(`✅ Updated ec_teams.gc_team_id for ${match.name}`);
          }
```

And update the match-finding logic to use `allSearchTeams`:
```javascript
        const match = matchedTeams.find(t => {
          const tp = (t.coach_phone || '').replace(/\D/g, '').slice(-10);
          return tp && tp === cleanPhone;
        });
```

## Also: Add gc_team_link column if it doesn't exist
Run in Supabase SQL Editor:
```sql
ALTER TABLE ec_teams ADD COLUMN IF NOT EXISTS gc_team_link TEXT;
```

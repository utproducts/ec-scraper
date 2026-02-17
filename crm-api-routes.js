// ═══════════════════════════════════════════════════════════════
// CRM + GC COLLECTION + EMAIL CAMPAIGN API ROUTES
// Add these to server.js on Render
// ═══════════════════════════════════════════════════════════════

// ─── GC SUBMISSION FORM ROUTES ──────────────────────────────

// Serve the GC submission form
app.get('/gc-submit', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'gc-submit.html'));
});
app.get('/gc-submit/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'gc-submit.html'));
});

// GET submission data by token (public - no auth)
app.get('/api/gc-submit/:token', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('gc_submissions')
      .select('*, crm_contacts(*)')
      .eq('token', req.params.token)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Not found' });

    res.json({
      team_name: data.team_name,
      age_group: data.age_group,
      team_class: data.team_class,
      coach_name: data.coach_name,
      submitted_at: data.submitted_at,
      no_gc: data.no_gc,
      gc_url: data.gc_url
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track form view
app.post('/api/gc-submit/:token/viewed', async (req, res) => {
  await supabase
    .from('gc_submissions')
    .update({ form_viewed_at: new Date().toISOString() })
    .eq('token', req.params.token)
    .is('form_viewed_at', null);
  res.json({ ok: true });
});

// POST submission (coach submits GC link)
app.post('/api/gc-submit/:token', async (req, res) => {
  try {
    const { gc_url, no_gc } = req.body;
    const token = req.params.token;

    // Get submission record
    const { data: sub } = await supabase
      .from('gc_submissions')
      .select('*')
      .eq('token', token)
      .single();

    if (!sub) return res.status(404).json({ error: 'Invalid token' });

    // Extract GC team ID from URL
    let gcTeamId = null;
    if (gc_url) {
      const match = gc_url.match(/teams\/([A-Za-z0-9]+)/);
      gcTeamId = match ? match[1] : null;
    }

    // Update submission
    await supabase
      .from('gc_submissions')
      .update({
        gc_url: gc_url || null,
        no_gc: !!no_gc,
        submitted_at: new Date().toISOString()
      })
      .eq('token', token);

    // Update CRM contact
    if (sub.contact_id) {
      await supabase
        .from('crm_contacts')
        .update({
          gc_team_url: gc_url || null,
          gc_team_id: gcTeamId,
          gc_status: no_gc ? 'no_gc' : 'submitted',
          gc_submitted_at: new Date().toISOString()
        })
        .eq('id', sub.contact_id);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── CRM ROUTES ─────────────────────────────────────────────

// GET all CRM contacts with filtering
app.get('/api/crm/contacts', async (req, res) => {
  try {
    const { state, age_group, gc_status, search, limit, offset, tag } = req.query;
    
    let query = supabase
      .from('crm_contacts')
      .select('*', { count: 'exact' })
      .eq('is_active', true)
      .order('updated_at', { ascending: false });

    if (state) query = query.contains('states_active', [state]);
    if (age_group) query = query.eq('age_group', age_group);
    if (gc_status) query = query.eq('gc_status', gc_status);
    if (tag) query = query.contains('tags', [tag]);
    if (search) {
      query = query.or(`team_name.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    query = query.range(
      parseInt(offset) || 0, 
      (parseInt(offset) || 0) + (parseInt(limit) || 50) - 1
    );

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({ contacts: data, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET CRM summary stats
app.get('/api/crm/summary', async (req, res) => {
  try {
    const { data } = await supabase.from('crm_summary').select('*').single();
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET GC progress by state
app.get('/api/crm/gc-progress', async (req, res) => {
  try {
    const { data } = await supabase.from('gc_progress_by_state').select('*');
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST import DC scraper CSV data into CRM
app.post('/api/crm/import-coaches', async (req, res) => {
  try {
    const { coaches, state } = req.body; // Array of coach objects from CSV

    let imported = 0;
    let skipped = 0;

    for (const coach of coaches) {
      const record = {
        first_name: coach.CoachFirst || coach.firstName,
        last_name: coach.CoachLast || coach.lastName,
        email: (coach.Email || coach.email || '').toLowerCase().trim(),
        phone: coach.Phone || coach.phone,
        phone2: coach.Phone2 || coach.phone2,
        team_name: coach.TeamName || coach.teamName,
        team_city: coach.TeamCity || coach.teamCity,
        team_state: coach.TeamState || coach.teamState || state,
        age_group: coach.AgeGroup || coach.ageGroup,
        team_class: coach.DivClass || coach.divClass || coach.teamClass,
        dc_team_id: coach.TeamID || coach.teamID,
        dc_registration: coach.Registration || coach.registration,
        states_active: [state || coach.State || 'FL'],
        source: 'dc_scraper',
        season: '2026'
      };

      // Skip if no identifying info
      if (!record.email && !record.phone && !record.first_name) {
        skipped++;
        continue;
      }

      // Upsert by registration + season, or email
      const { error } = await supabase
        .from('crm_contacts')
        .upsert(record, { 
          onConflict: 'dc_registration,season',
          ignoreDuplicates: false 
        });

      if (error) {
        // Try by email if registration conflict fails
        if (record.email) {
          const { data: existing } = await supabase
            .from('crm_contacts')
            .select('id')
            .eq('email', record.email)
            .eq('season', '2026')
            .single();

          if (existing) {
            await supabase
              .from('crm_contacts')
              .update(record)
              .eq('id', existing.id);
          } else {
            await supabase.from('crm_contacts').insert(record);
          }
        }
        skipped++;
      } else {
        imported++;
      }
    }

    res.json({ imported, skipped, total: coaches.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── EMAIL CAMPAIGN ROUTES ──────────────────────────────────

// GET email templates
app.get('/api/email/templates', async (req, res) => {
  try {
    const { data } = await supabase
      .from('email_templates')
      .select('*')
      .order('created_at');
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST save email template
app.post('/api/email/templates', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('email_templates')
      .insert(req.body)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET campaigns list
app.get('/api/email/campaigns', async (req, res) => {
  try {
    const { data } = await supabase
      .from('email_campaigns')
      .select('*')
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create campaign
app.post('/api/email/campaigns', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('email_campaigns')
      .insert(req.body)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST generate GC collection tokens for filtered contacts
app.post('/api/crm/generate-gc-tokens', async (req, res) => {
  try {
    const { filter } = req.body; // {state, age_group, gc_status: 'unknown'}
    
    // Get matching contacts
    let query = supabase
      .from('crm_contacts')
      .select('*')
      .eq('is_active', true)
      .eq('gc_status', 'unknown')
      .not('email', 'is', null);

    if (filter?.state) query = query.contains('states_active', [filter.state]);
    if (filter?.age_group) query = query.eq('age_group', filter.age_group);

    const { data: contacts } = await query;

    // Generate submission tokens
    let created = 0;
    for (const contact of (contacts || [])) {
      const token = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
      
      // Check if token already exists for this contact
      const { data: existing } = await supabase
        .from('gc_submissions')
        .select('id')
        .eq('contact_id', contact.id)
        .single();

      if (!existing) {
        await supabase.from('gc_submissions').insert({
          contact_id: contact.id,
          token,
          team_name: contact.team_name,
          age_group: contact.age_group,
          team_class: contact.team_class,
          coach_name: `${contact.first_name} ${contact.last_name}`.trim()
        });
        created++;
      }
    }

    res.json({ contacts_matched: (contacts || []).length, tokens_created: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST send GC collection campaign (email)
// NOTE: This requires an email service like SendGrid, Resend, or AWS SES
// For now, this generates the send queue. Actual sending TBD based on email provider choice.
app.post('/api/email/send-campaign/:campaignId', async (req, res) => {
  try {
    const campaignId = req.params.campaignId;
    
    // Get campaign
    const { data: campaign } = await supabase
      .from('email_campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();

    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Get matching contacts with GC submission tokens
    const filter = campaign.target_filter || {};
    let query = supabase
      .from('crm_contacts')
      .select('*, gc_submissions(*)')
      .eq('is_active', true)
      .eq('opted_out', false)
      .not('email', 'is', null);

    if (filter.state) query = query.contains('states_active', [filter.state]);
    if (filter.age_group) query = query.eq('age_group', filter.age_group);
    if (filter.gc_status) query = query.eq('gc_status', filter.gc_status);

    const { data: contacts } = await query;

    // Create email log entries
    let queued = 0;
    for (const contact of (contacts || [])) {
      // Get or create GC submission token
      let submissionToken = contact.gc_submissions?.[0]?.token;
      if (!submissionToken) {
        submissionToken = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
        await supabase.from('gc_submissions').insert({
          contact_id: contact.id,
          token: submissionToken,
          team_name: contact.team_name,
          age_group: contact.age_group,
          team_class: contact.team_class,
          coach_name: `${contact.first_name} ${contact.last_name}`.trim()
        });
      }

      // Build personalized HTML
      const submissionUrl = `https://unrivaled-connect-backend.onrender.com/gc-submit/${submissionToken}`;
      let html = campaign.html_content
        .replace(/\{\{coach_first_name\}\}/g, contact.first_name || 'Coach')
        .replace(/\{\{team_name\}\}/g, contact.team_name || 'your team')
        .replace(/\{\{age_group\}\}/g, contact.age_group || '')
        .replace(/\{\{team_class\}\}/g, contact.team_class || '')
        .replace(/\{\{season\}\}/g, '2026')
        .replace(/\{\{submission_url\}\}/g, submissionUrl)
        .replace(/\{\{unsubscribe_url\}\}/g, `https://unrivaled-connect-backend.onrender.com/unsubscribe/${contact.id}`);

      await supabase.from('email_log').insert({
        campaign_id: campaignId,
        contact_id: contact.id,
        email_to: contact.email,
        status: 'queued'
      });
      queued++;
    }

    // Update campaign
    await supabase
      .from('email_campaigns')
      .update({ 
        status: 'queued', 
        recipient_count: queued,
        emails_sent: 0 
      })
      .eq('id', campaignId);

    res.json({ queued, total_contacts: (contacts || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unsubscribe route
app.get('/unsubscribe/:contactId', async (req, res) => {
  await supabase
    .from('crm_contacts')
    .update({ opted_out: true, opted_out_at: new Date().toISOString() })
    .eq('id', req.params.contactId);
  
  res.send(`
    <html><body style="font-family:Arial;text-align:center;padding:60px;background:#0a0e1a;color:#eee;">
      <h2>You've been unsubscribed</h2>
      <p>You won't receive any more emails from us.</p>
    </body></html>
  `);
});

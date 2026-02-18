/**
 * Patch: Auto-Contact Collection for SMS Bot
 * 
 * Adds logic to server.js so when someone texts in and isn't in crm_contacts:
 * 1. The AI bot still answers their question
 * 2. But also asks for their name, team, and age group
 * 3. When they reply with that info, it auto-parses and stores in crm_contacts
 * 
 * Run: node patch-contact-collection.mjs
 */
import fs from 'fs';

const file = 'server.js';
let code = fs.readFileSync(file, 'utf-8');

// ═══════════════════════════════════════════════════════════
// 1. Add the contact collection helper functions
// ═══════════════════════════════════════════════════════════

const contactHelpers = `
// ─── AUTO CONTACT COLLECTION ─────────────────────────────
async function lookupContact(phone) {
  const cleanPhone = phone.replace(/\\D/g, '').slice(-10);
  try {
    const { data } = await supabase.from('crm_contacts')
      .select('id, first_name, last_name, team_name, age_group, email')
      .or('phone.like.%' + cleanPhone + ',phone2.like.%' + cleanPhone)
      .limit(1);
    return (data && data.length > 0) ? data[0] : null;
  } catch (err) {
    console.error('Contact lookup error:', err.message);
    return null;
  }
}

async function checkPendingInfoRequest(phone) {
  const cleanPhone = phone.replace(/\\D/g, '').slice(-10);
  try {
    const { data } = await supabase.from('sms_log')
      .select('created_at')
      .eq('phone_from', phone)
      .like('question', '%[System] Requested contact info%')
      .order('created_at', { ascending: false })
      .limit(1);
    if (!data || data.length === 0) return false;
    // Check if request was within last 24 hours
    const requestTime = new Date(data[0].created_at);
    const now = new Date();
    return (now - requestTime) < 24 * 60 * 60 * 1000;
  } catch (err) { return false; }
}

function parseContactInfo(text) {
  // Try to parse name, team, and age group from a reply
  const lines = text.split(/[\\n,;]+/).map(l => l.trim()).filter(l => l);
  let firstName = null, lastName = null, teamName = null, ageGroup = null;
  
  // Look for age group pattern anywhere in text
  const ageMatch = text.match(/\\b(\\d{1,2})[uU]\\b/);
  if (ageMatch) ageGroup = ageMatch[1] + 'U';
  
  // Try parsing structured replies (numbered lines)
  for (const line of lines) {
    const cleaned = line.replace(/^[1-3][.)\\s-]+/, '').trim();
    if (!cleaned) continue;
    
    // Check if this line looks like a name (2-3 words, no numbers except jersey)
    const nameCheck = cleaned.replace(/^(coach|Coach|COACH)\\s+/i, '');
    const words = nameCheck.split(/\\s+/);
    if (!firstName && words.length >= 1 && words.length <= 4 && !/\\d{2,}/.test(nameCheck) && !/[uU]$/.test(nameCheck)) {
      firstName = words[0];
      lastName = words.slice(1).join(' ') || null;
      continue;
    }
    
    // Check if this looks like a team name (longer, may have location words)
    if (!teamName && cleaned.length > 2 && cleaned !== ageGroup) {
      // Skip if it's just the age group
      if (!cleaned.match(/^\\d{1,2}[uU]$/)) {
        teamName = cleaned;
      }
    }
  }
  
  return { firstName, lastName, teamName, ageGroup };
}

async function saveContactFromReply(phone, info) {
  const cleanPhone = phone.replace(/\\D/g, '').slice(-10);
  const fullPhone = '+1' + cleanPhone;
  
  try {
    // Check if already exists
    const { data: existing } = await supabase.from('crm_contacts')
      .select('id')
      .or('phone.like.%' + cleanPhone + ',phone2.like.%' + cleanPhone)
      .limit(1);
    
    if (existing && existing.length > 0) {
      const updates = {};
      if (info.firstName) updates.first_name = info.firstName;
      if (info.lastName) updates.last_name = info.lastName;
      if (info.teamName) updates.team_name = info.teamName;
      if (info.ageGroup) updates.age_group = info.ageGroup;
      await supabase.from('crm_contacts').update(updates).eq('id', existing[0].id);
      console.log('Updated contact:', info.firstName, info.lastName, phone);
    } else {
      await supabase.from('crm_contacts').insert({
        first_name: info.firstName || null,
        last_name: info.lastName || null,
        phone: fullPhone,
        team_name: info.teamName || null,
        age_group: info.ageGroup || null,
        is_active: true,
        source: 'sms_auto_collected'
      });
      console.log('Created contact:', info.firstName, info.lastName, phone);
    }
    return true;
  } catch (err) {
    console.error('Save contact error:', err.message);
    return false;
  }
}
`;

// Find a good insertion point — after supabase client creation
const supabaseLineIdx = code.indexOf('const supabase = createClient(');
if (supabaseLineIdx === -1) {
  // Try alternative patterns
  const altIdx = code.indexOf('supabase.createClient(');
  if (altIdx !== -1) {
    // Find end of that statement
    const endIdx = code.indexOf(';', altIdx);
    if (endIdx !== -1) {
      code = code.slice(0, endIdx + 1) + '\n' + contactHelpers + code.slice(endIdx + 1);
      console.log('✅ Added contact collection helper functions');
    }
  } else {
    console.log('⚠️ Could not find supabase client creation. Adding helpers at top of file after imports.');
    const lastImport = code.lastIndexOf("import ");
    const endOfImport = code.indexOf('\n', lastImport);
    code = code.slice(0, endOfImport + 1) + '\n' + contactHelpers + code.slice(endOfImport + 1);
    console.log('✅ Added contact collection helper functions (after imports)');
  }
} else {
  const endIdx = code.indexOf(';', supabaseLineIdx);
  code = code.slice(0, endIdx + 1) + '\n' + contactHelpers + code.slice(endIdx + 1);
  console.log('✅ Added contact collection helper functions');
}

// ═══════════════════════════════════════════════════════════
// 2. Update the SMS webhook to check contacts and add the info request
// ═══════════════════════════════════════════════════════════

// Find the SMS webhook handler — look for common patterns
const smsWebhookPatterns = [
  "app.post('/sms'",
  'app.post("/sms"',
  "router.post('/sms'",
];

let webhookFound = false;
for (const pattern of smsWebhookPatterns) {
  if (code.includes(pattern)) {
    // Find the body/message extraction line
    const bodyPatterns = [
      'const body = req.body.Body',
      'const message = req.body.Body',
      'let body = req.body.Body',
      'const incomingMsg = req.body.Body',
      'const question = req.body.Body',
    ];
    
    for (const bp of bodyPatterns) {
      if (code.includes(bp)) {
        // Insert contact check right after the body extraction
        const bpIdx = code.indexOf(bp);
        const bpEnd = code.indexOf(';', bpIdx);
        
        const contactCheck = `
    
    // ─── AUTO CONTACT COLLECTION ─────────────
    const senderPhone = req.body.From || '';
    const existingContact = await lookupContact(senderPhone);
    let contactCollectionNote = '';
    
    if (!existingContact) {
      // Check if this looks like a reply to our info request
      const pendingRequest = await checkPendingInfoRequest(senderPhone);
      const parsed = parseContactInfo(req.body.Body || '');
      
      if (parsed.firstName) {
        // They sent us info — save it!
        await saveContactFromReply(senderPhone, parsed);
        contactCollectionNote = '\\n\\nThanks for sharing your info! We\\'ve got you in our system now. ⚾';
      } else if (!pendingRequest) {
        // First time unknown contact — ask for info after answering their question
        contactCollectionNote = '\\n\\n---\\nBy the way, we don\\'t have your info in our system yet! Could you reply with your name, team name, and age group so we can keep you updated on tournament results and your players\\' stats? 🙏';
        // Mark that we asked
        await supabase.from('sms_log').insert({
          phone_from: senderPhone,
          question: '[System] Requested contact info',
          response: 'Auto-requested on first unknown contact message',
          status: 'answered'
        }).then(() => {}).catch(() => {});
      }
    }`;
        
        code = code.slice(0, bpEnd + 1) + contactCheck + code.slice(bpEnd + 1);
        
        // Now find where the response is sent back and append contactCollectionNote
        // Look for the TwiML response or the send message part
        const twimlPatterns = [
          'twiml.message(',
          'response.message(',
          'MessagingResponse()',
        ];
        
        // Also try to find where aiResponse or responseText is used
        console.log('✅ Added contact check to SMS webhook');
        console.log('');
        console.log('⚠️  IMPORTANT: You need to manually add "contactCollectionNote" to your AI response.');
        console.log('   Find the line where you send the AI response back (twiml.message or similar)');
        console.log('   and append contactCollectionNote to it.');
        console.log('');
        console.log('   Example:');
        console.log('   BEFORE: twiml.message(aiResponse);');
        console.log('   AFTER:  twiml.message(aiResponse + contactCollectionNote);');
        console.log('');
        
        webhookFound = true;
        break;
      }
    }
    if (webhookFound) break;
  }
}

if (!webhookFound) {
  console.log('⚠️  Could not find SMS webhook handler automatically.');
  console.log('   The helper functions have been added to server.js.');
  console.log('   You need to manually call these in your SMS webhook:');
  console.log('');
  console.log('   1. const contact = await lookupContact(req.body.From);');
  console.log('   2. If no contact, append info request to AI response');
  console.log('   3. If they reply with info, call parseContactInfo() + saveContactFromReply()');
}

// ═══════════════════════════════════════════════════════════
// 3. Add API endpoint for sending SMS from dashboard
// ═══════════════════════════════════════════════════════════

if (!code.includes("'/api/send-sms'") && !code.includes('"/api/send-sms"')) {
  // Add a simple send-sms endpoint
  const sendSmsEndpoint = `
// ─── SEND SMS ENDPOINT (for dashboard) ─────────────────
app.post('/api/send-sms', async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });
    
    const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to.startsWith('+') ? to : '+1' + to.replace(/\\D/g, '').slice(-10)
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Send SMS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
`;

  // Find app.listen or the last route definition
  const listenIdx = code.indexOf('app.listen(');
  if (listenIdx !== -1) {
    code = code.slice(0, listenIdx) + sendSmsEndpoint + '\n' + code.slice(listenIdx);
    console.log('✅ Added /api/send-sms endpoint');
  }
}

fs.writeFileSync(file, code);
console.log('');
console.log('✅ Patch complete! Push to deploy:');
console.log('   git add -A && git commit -m "Add auto contact collection" && git push origin main');

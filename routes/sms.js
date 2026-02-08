const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Send SMS campaign
router.post('/send-campaign', async (req, res) => {
  try {
    const { fromNumber, contacts, message, directorId } = req.body;

    if (!fromNumber || !contacts || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const results = [];
    let totalCost = 0;

    // Send to each contact
    for (const contact of contacts) {
      try {
        const sms = await twilioClient.messages.create({
          body: message,
          from: fromNumber,
          to: contact.phone
        });

        const smsCost = 0.045; // Your pricing: $0.045 per outbound SMS
        totalCost += smsCost;

        // Log message in database
        await supabase.from('messages').insert({
          director_id: directorId,
          from_number: fromNumber,
          to_number: contact.phone,
          body: message,
          direction: 'outbound',
          twilio_sid: sms.sid,
          cost: smsCost
        });

        results.push({
          phone: contact.phone,
          status: 'sent',
          sid: sms.sid
        });

      } catch (error) {
        console.error(`Failed to send to ${contact.phone}:`, error);
        results.push({
          phone: contact.phone,
          status: 'failed',
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      sent: results.filter(r => r.status === 'sent').length,
      failed: results.filter(r => r.status === 'failed').length,
      totalCost: totalCost.toFixed(2),
      results
    });

  } catch (error) {
    console.error('Campaign error:', error);
    res.status(500).json({ error: 'Failed to send campaign' });
  }
});

// Get available Twilio numbers
router.get('/available-numbers', async (req, res) => {
  try {
    const { areaCode } = req.query;

    const numbers = await twilioClient
      .availablePhoneNumbers('US')
      .local
      .list({
        areaCode: areaCode || '941', // Default to Sarasota area
        limit: 10
      });

    res.json({
      numbers: numbers.map(n => ({
        phoneNumber: n.phoneNumber,
        friendlyName: n.friendlyName,
        locality: n.locality,
        region: n.region
      }))
    });

  } catch (error) {
    console.error('Error fetching numbers:', error);
    res.status(500).json({ error: 'Failed to fetch available numbers' });
  }
});

// Purchase Twilio number
router.post('/purchase-number', async (req, res) => {
  try {
    const { phoneNumber, directorId } = req.body;

    const purchasedNumber = await twilioClient
      .incomingPhoneNumbers
      .create({
        phoneNumber: phoneNumber,
        smsUrl: `${process.env.BASE_URL || 'http://localhost:3001'}/api/sms/webhook`,
        smsMethod: 'POST'
      });

    // Update director's phone number in database
    await supabase
      .from('directors')
      .update({ twilio_phone_number: phoneNumber })
      .eq('id', directorId);

    res.json({
      success: true,
      phoneNumber: purchasedNumber.phoneNumber,
      sid: purchasedNumber.sid,
      monthlyCost: 5.00 // Your pricing: $5/month
    });

  } catch (error) {
    console.error('Error purchasing number:', error);
    res.status(500).json({ error: 'Failed to purchase number' });
  }
});

module.exports = router;
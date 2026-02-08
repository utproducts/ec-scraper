require('dotenv').config();
const axios = require('axios');

async function testSMS() {
  try {
const YOUR_PHONE = '+16308647869';
const FROM_NUMBER = '+14074568412';
    console.log(`📱 Sending test SMS from ${FROM_NUMBER} to ${YOUR_PHONE}...`);

    const response = await axios.post('http://localhost:3001/api/sms/send-campaign', {
      fromNumber: FROM_NUMBER,
      contacts: [
        { phone: YOUR_PHONE, name: 'Chad' }
      ],
      message: '🚀 TEST from Unrivaled Connect! If you got this, the system works! Reply to test AI response.',
      directorId: 'test-director-123'
    });

    console.log('✅ SMS SENT!');
    console.log('Response:', response.data);
    console.log('\nNow reply to the text and watch the AI respond! 🤖');

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

testSMS();
// GTC TRACKING - SMS Relay Server
// Deploy this to Render.com for free automatic SMS sending

const express = require('express');
const cors    = require('cors');
const AfricasTalking = require('africastalking');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---- CORS: allow your Netlify domain (and localhost for testing) ----
app.use(cors({
  origin: [
    'https://*.netlify.app',  // all netlify apps
    'https://*.netlify.com',
    'http://localhost',
    'http://127.0.0.1',
    'null',                   // local HTML file
    '*'                       // fallback — restrict to your domain in production
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Secret']
}));

app.use(express.json({ limit: '1mb' }));

// ---- Simple API secret to protect your server ----
// Set GTC_API_SECRET as an environment variable on Render
const API_SECRET = process.env.GTC_API_SECRET || 'gtc-secret-2024';

function checkSecret(req, res) {
  const secret = req.headers['x-api-secret'] || req.body.apiSecret;
  if (secret !== API_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ---- Health check ----
app.get('/', (req, res) => {
  res.json({
    status: 'GTC SMS Relay Server is running',
    version: '1.0.0',
    endpoints: ['/send-sms', '/send-bulk', '/test']
  });
});

app.get('/test', (req, res) => {
  res.json({ ok: true, message: 'Server reachable' });
});

// ---- Send single SMS ----
app.post('/send-sms', async (req, res) => {
  if (!checkSecret(req, res)) return;

  const { username, apiKey, to, message, from } = req.body;

  if (!username || !apiKey || !to || !message) {
    return res.status(400).json({ error: 'Missing required fields: username, apiKey, to, message' });
  }

  try {
    const AT = AfricasTalking({ username, apiKey });
    const sms = AT.SMS;

    const result = await sms.send({
      to: Array.isArray(to) ? to : [to],
      message,
      from: from || undefined
    });

    const recipients = result.SMSMessageData.Recipients;
    const success = recipients.filter(r => r.status === 'Success').length;
    const failed  = recipients.filter(r => r.status !== 'Success').length;

    res.json({
      ok: true,
      total: recipients.length,
      success,
      failed,
      recipients,
      cost: result.SMSMessageData.Message
    });
  } catch (err) {
    console.error('SMS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Send bulk SMS to multiple members at once ----
app.post('/send-bulk', async (req, res) => {
  if (!checkSecret(req, res)) return;

  const { username, apiKey, messages, from } = req.body;
  // messages = array of { to: '+254...', message: '...' }

  if (!username || !apiKey || !messages || !messages.length) {
    return res.status(400).json({ error: 'Missing: username, apiKey, messages[]' });
  }

  const AT = AfricasTalking({ username, apiKey });
  const sms = AT.SMS;

  const results = [];
  let successCount = 0;
  let failCount = 0;

  // Send all in parallel for speed
  const promises = messages.map(async (item) => {
    try {
      const result = await sms.send({
        to: [item.to],
        message: item.message,
        from: from || undefined
      });
      const r = result.SMSMessageData.Recipients[0];
      const ok = r && r.status === 'Success';
      if (ok) successCount++; else failCount++;
      return { to: item.to, name: item.name, status: ok ? 'sent' : 'failed', detail: r };
    } catch (e) {
      failCount++;
      return { to: item.to, name: item.name, status: 'error', error: e.message };
    }
  });

  const settled = await Promise.allSettled(promises);
  settled.forEach(r => results.push(r.value || r.reason));

  res.json({
    ok: true,
    total: messages.length,
    success: successCount,
    failed: failCount,
    results
  });
});

app.listen(PORT, () => {
  console.log('GTC SMS Relay running on port ' + PORT);
});

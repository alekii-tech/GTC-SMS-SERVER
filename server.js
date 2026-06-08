const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Send one SMS to one number via Africa's Talking
function sendOneSMS(apiKey, username, to, message, from, sandbox) {
  return new Promise(function(resolve, reject) {
    var host = sandbox
      ? 'api.sandbox.africastalking.com'
      : 'api.africastalking.com';

    var params = 'username=' + encodeURIComponent(username) +
                 '&to='      + encodeURIComponent(to) +
                 '&message=' + encodeURIComponent(message) +
                 '&bulkSMSMode=1';
    if (from) params += '&from=' + encodeURIComponent(from);

    var options = {
      hostname: host,
      port:     443,
      path:     '/version1/messaging',
      method:   'POST',
      headers: {
        'Accept':         'application/json',
        'Content-Type':   'application/x-www-form-urlencoded',
        'apiKey':          apiKey,
        'Content-Length':  Buffer.byteLength(params)
      }
    };

    var req = https.request(options, function(resp) {
      var data = '';
      resp.on('data', function(d) { data += d; });
      resp.on('end', function() {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: resp.statusCode, body: {}, raw: data }); }
      });
    });

    req.on('error', reject);
    req.write(params);
    req.end();
  });
}

// Format phone to +254XXXXXXXXX
function formatPhone(phone) {
  var p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0'))   p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  if (!p.startsWith('254')) p = '254' + p;
  return '+' + p;
}

// Health check
app.get('/',     function(req, res) { res.json({ status: 'GTC SMS Relay running', version: '7.0.0' }); });
app.get('/test', function(req, res) { res.json({ ok: true, message: 'Server reachable' }); });

// ── SEND BULK SMS — each member gets their OWN personalised message ──
app.post('/send-bulk', async function(req, res) {
  var username = req.body.username;
  var apiKey   = req.body.apiKey;
  var messages = req.body.messages; // [{ to, name, message }]
  var from     = req.body.from     || null;
  var sandbox  = req.body.sandbox  || false;

  if (!username || !apiKey) return res.status(400).json({ error: 'Missing AT username or apiKey' });
  if (!messages || !messages.length) return res.status(400).json({ error: 'No messages provided' });

  console.log('=== BULK SEND START: ' + messages.length + ' members | Sandbox=' + sandbox + ' ===');

  var successCount = 0;
  var failCount    = 0;
  var results      = [];

  // Send to each member individually with THEIR OWN message
  for (var i = 0; i < messages.length; i++) {
    var item           = messages[i];
    var formattedPhone = formatPhone(item.to);

    console.log('[' + (i+1) + '/' + messages.length + '] Sending to: ' + item.name + ' (' + formattedPhone + ')');

    try {
      var resp       = await sendOneSMS(apiKey, username, formattedPhone, item.message, from, sandbox);
      var msgData    = resp.body && resp.body.SMSMessageData ? resp.body.SMSMessageData : {};
      var recipients = msgData.Recipients || [];
      var r          = recipients[0] || {};
      var ok         = r.status === 'Success';

      if (ok) {
        successCount++;
        console.log('  ✓ Delivered to ' + item.name);
      } else {
        failCount++;
        console.log('  ✗ Failed for ' + item.name + ': ' + (r.status || msgData.Message || 'unknown'));
      }

      results.push({
        to:     formattedPhone,
        name:   item.name,
        status: ok ? 'sent' : 'failed',
        detail: r.status || msgData.Message || 'no response'
      });

    } catch(e) {
      failCount++;
      console.log('  ✗ Error for ' + item.name + ': ' + e.message);
      results.push({ to: formattedPhone, name: item.name, status: 'error', error: e.message });
    }

    // Small delay between sends to avoid rate limiting
    if (i < messages.length - 1) {
      await new Promise(function(r){ setTimeout(r, 200); });
    }
  }

  console.log('=== BULK SEND DONE: ' + successCount + ' sent, ' + failCount + ' failed ===');

  res.json({
    ok:      true,
    total:   messages.length,
    success: successCount,
    failed:  failCount,
    results: results
  });
});

// ── SEND SINGLE SMS (for test button) ──
app.post('/send-sms', async function(req, res) {
  var username = req.body.username;
  var apiKey   = req.body.apiKey;
  var to       = req.body.to;
  var message  = req.body.message;
  var from     = req.body.from    || null;
  var sandbox  = req.body.sandbox || false;

  if (!username || !apiKey || !to || !message) {
    return res.status(400).json({ error: 'Missing: username, apiKey, to, message' });
  }

  var formattedTo = formatPhone(to);
  console.log('Single SMS to: ' + formattedTo);

  try {
    var resp       = await sendOneSMS(apiKey, username, formattedTo, message, from, sandbox);
    var msgData    = resp.body && resp.body.SMSMessageData ? resp.body.SMSMessageData : {};
    var recipients = msgData.Recipients || [];
    var success    = recipients.filter(function(r){ return r.status === 'Success'; }).length;
    var failed     = recipients.filter(function(r){ return r.status !== 'Success'; }).length;
    res.json({ ok: true, total: recipients.length, success: success, failed: failed, recipients: recipients, atMessage: msgData.Message || '' });
  } catch(err) {
    console.error('send-sms error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CHECK AT BALANCE ──
app.post('/at-balance', async function(req, res) {
  var username = req.body.username;
  var apiKey   = req.body.apiKey;
  var sandbox  = req.body.sandbox || false;
  var host     = sandbox ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';

  var options = {
    hostname: host,
    path:     '/version1/user?username=' + encodeURIComponent(username),
    method:   'GET',
    headers:  { 'Accept': 'application/json', 'apiKey': apiKey }
  };

  var request = https.request(options, function(resp) {
    var data = '';
    resp.on('data',  function(d){ data += d; });
    resp.on('end', function(){
      try {
        var parsed  = JSON.parse(data);
        var balance = parsed.UserData ? parsed.UserData.balance : null;
        balance
          ? res.json({ ok: true, balance: balance })
          : res.json({ ok: false, error: data });
      } catch(e) {
        res.status(500).json({ error: data });
      }
    });
  });
  request.on('error', function(e){ res.status(500).json({ error: e.message }); });
  request.end();
});

app.listen(PORT, function() {
  console.log('GTC SMS Relay v7.0 on port ' + PORT);
  console.log('Each member receives their OWN personalised message');
});

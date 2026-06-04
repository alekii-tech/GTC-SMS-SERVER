const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// POST directly to Africa's Talking bulk SMS endpoint
function postToAT(apiKey, username, to, message, from, sandbox) {
  return new Promise(function(resolve, reject) {
    var host = sandbox
      ? 'api.sandbox.africastalking.com'
      : 'api.africastalking.com';

    var bodyObj = {
      username:    username,
      to:          to,
      message:     message,
      bulkSMSMode: 1
    };
    if (from) bodyObj.from = from;

    var body = JSON.stringify(bodyObj);

    console.log('POST to: https://' + host + '/version1/messaging/bulk');
    console.log('To:', to, '| Username:', username);

    var options = {
      hostname: host,
      port:     443,
      path:     '/version1/messaging/bulk',
      method:   'POST',
      headers: {
        'Accept':         'application/json',
        'Content-Type':   'application/json',
        'apiKey':          apiKey,
        'Content-Length':  Buffer.byteLength(body)
      }
    };

    var req = https.request(options, function(resp) {
      var data = '';
      resp.on('data', function(d) { data += d; });
      resp.on('end', function() {
        console.log('AT status:', resp.statusCode, '| Response:', data);
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: resp.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Health check
app.get('/',     function(req, res) { res.json({ status: 'GTC SMS Relay running', version: '5.0.0' }); });
app.get('/test', function(req, res) { res.json({ ok: true, message: 'Server reachable' }); });

// Send bulk SMS — no auth check, just forwards straight to AT
app.post('/send-bulk', async function(req, res) {
  var username = req.body.username;
  var apiKey   = req.body.apiKey;
  var messages = req.body.messages;
  var from     = req.body.from     || null;
  var sandbox  = req.body.sandbox  || false;

  if (!username || !apiKey) return res.status(400).json({ error: 'Missing AT username or apiKey' });
  if (!messages || !messages.length) return res.status(400).json({ error: 'No messages provided' });

  console.log('Bulk send: ' + messages.length + ' messages | Sandbox=' + sandbox);

  var successCount = 0;
  var failCount    = 0;
  var results      = [];

  for (var i = 0; i < messages.length; i++) {
    var item = messages[i];
    try {
      var resp       = await postToAT(apiKey, username, item.to, item.message, from, sandbox);
      var recipients = resp.body && resp.body.SMSMessageData
                       ? resp.body.SMSMessageData.Recipients : [];
      var r          = recipients[0];
      var ok         = r && r.status === 'Success';

      if (ok) successCount++; else failCount++;
      results.push({ to: item.to, name: item.name || '', status: ok ? 'sent' : 'failed', detail: r ? r.status : JSON.stringify(resp.body) });
      console.log((ok ? 'SENT' : 'FAIL') + ': ' + item.to);
    } catch(e) {
      failCount++;
      results.push({ to: item.to, name: item.name || '', status: 'error', error: e.message });
      console.error('Error ' + item.to + ':', e.message);
    }
  }

  res.json({ ok: true, total: messages.length, success: successCount, failed: failCount, results: results });
});

// Send single SMS — for test button
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

  try {
    var resp       = await postToAT(apiKey, username, to, message, from, sandbox);
    var recipients = resp.body && resp.body.SMSMessageData
                     ? resp.body.SMSMessageData.Recipients : [];
    var success    = recipients.filter(function(r){ return r.status === 'Success'; }).length;
    var failed     = recipients.filter(function(r){ return r.status !== 'Success'; }).length;
    res.json({ ok: true, total: recipients.length, success: success, failed: failed, recipients: recipients });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Check AT balance
app.post('/at-balance', async function(req, res) {
  var username = req.body.username;
  var apiKey   = req.body.apiKey;
  var sandbox  = req.body.sandbox || false;
  var host     = sandbox ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';

  var options = {
    hostname: host,
    path:     '/version1/user?username=' + username,
    method:   'GET',
    headers:  { 'Accept': 'application/json', 'apiKey': apiKey }
  };

  var request = https.request(options, function(resp) {
    var data = '';
    resp.on('data', function(d) { data += d; });
    resp.on('end', function() {
      try {
        var parsed  = JSON.parse(data);
        var balance = parsed.UserData ? parsed.UserData.balance : null;
        balance ? res.json({ ok: true, balance: balance }) : res.json({ ok: false, error: data });
      } catch(e) { res.status(500).json({ error: data }); }
    });
  });
  request.on('error', function(e) { res.status(500).json({ error: e.message }); });
  request.end();
});

app.listen(PORT, function() {
  console.log('GTC SMS Relay v5.0 on port ' + PORT);
});
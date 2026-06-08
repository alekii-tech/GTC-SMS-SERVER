const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Direct POST to Africa's Talking
function postToAT(apiKey, username, to, message, from, sandbox) {
  return new Promise(function(resolve, reject) {
    var host = sandbox
      ? 'api.sandbox.africastalking.com'
      : 'api.africastalking.com';

    // AT expects comma-separated numbers in the 'to' field
    var params = 'username=' + encodeURIComponent(username) +
                 '&to='      + encodeURIComponent(to) +
                 '&message=' + encodeURIComponent(message) +
                 '&bulkSMSMode=1';
    if (from) params += '&from=' + encodeURIComponent(from);

    console.log('POST https://' + host + '/version1/messaging');
    console.log('username=' + username + ' | to=' + to);

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
        console.log('AT HTTP status:', resp.statusCode);
        console.log('AT response:', data);
        try { resolve({ status: resp.statusCode, body: JSON.parse(data), raw: data }); }
        catch(e) { resolve({ status: resp.statusCode, body: {}, raw: data }); }
      });
    });

    req.on('error', function(e) {
      console.error('Request error:', e.message);
      reject(e);
    });
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

app.get('/',     function(req, res) { res.json({ status: 'GTC SMS Relay running', version: '6.0.0' }); });
app.get('/test', function(req, res) { res.json({ ok: true, message: 'Server reachable' }); });

// Send single SMS
app.post('/send-sms', async function(req, res) {
  var username = req.body.username;
  var apiKey   = req.body.apiKey;
  var to       = req.body.to;
  var message  = req.body.message;
  var from     = req.body.from     || null;
  var sandbox  = req.body.sandbox  || false;

  if (!username || !apiKey || !to || !message) {
    return res.status(400).json({ error: 'Missing: username, apiKey, to, message' });
  }

  var formattedTo = formatPhone(to);
  console.log('Sending single SMS to:', formattedTo);

  try {
    var resp       = await postToAT(apiKey, username, formattedTo, message, from, sandbox);
    var atData     = resp.body;
    var msgData    = atData.SMSMessageData || {};
    var recipients = msgData.Recipients    || [];
    var success    = recipients.filter(function(r){ return r.status==='Success'; }).length;
    var failed     = recipients.filter(function(r){ return r.status!=='Success'; }).length;

    res.json({
      ok:         true,
      total:      recipients.length,
      success:    success,
      failed:     failed,
      recipients: recipients,
      atMessage:  msgData.Message || '',
      raw:        resp.raw
    });
  } catch(err) {
    console.error('send-sms error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send bulk SMS
app.post('/send-bulk', async function(req, res) {
  var username = req.body.username;
  var apiKey   = req.body.apiKey;
  var messages = req.body.messages;
  var from     = req.body.from    || null;
  var sandbox  = req.body.sandbox || false;

  if (!username || !apiKey || !messages || !messages.length) {
    return res.status(400).json({ error: 'Missing: username, apiKey, messages[]' });
  }

  // Format all numbers and build one comma-separated string for efficiency
  var numbers  = messages.map(function(m){ return formatPhone(m.to); }).join(',');
  var message  = messages[0].message; // Use first message for bulk (same message to all)

  console.log('Bulk sending to', messages.length, 'recipients');
  console.log('Numbers:', numbers);

  try {
    var resp       = await postToAT(apiKey, username, numbers, message, from, sandbox);
    var atData     = resp.body;
    var msgData    = atData.SMSMessageData || {};
    var recipients = msgData.Recipients    || [];
    var success    = recipients.filter(function(r){ return r.status==='Success'; }).length;
    var failed     = recipients.filter(function(r){ return r.status!=='Success'; }).length;

    var results = recipients.map(function(r){
      return { to: r.number, status: r.status==='Success'?'sent':'failed', detail: r.status };
    });

    console.log('Sent:', success, '| Failed:', failed);
    res.json({
      ok:        true,
      total:     recipients.length,
      success:   success,
      failed:    failed,
      results:   results,
      atMessage: msgData.Message || '',
      raw:       resp.raw
    });
  } catch(err) {
    console.error('send-bulk error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Check AT account balance
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
      console.log('Balance response:', data);
      try {
        var parsed  = JSON.parse(data);
        var balance = parsed.UserData ? parsed.UserData.balance : null;
        if (balance) {
          res.json({ ok: true, balance: balance });
        } else {
          res.json({ ok: false, error: data, raw: data });
        }
      } catch(e) {
        res.status(500).json({ error: data });
      }
    });
  });
  request.on('error', function(e){ res.status(500).json({ error: e.message }); });
  request.end();
});

app.listen(PORT, function() {
  console.log('GTC SMS Relay v6.0 running on port ' + PORT);
});

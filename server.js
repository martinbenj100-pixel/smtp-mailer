const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── STORAGE EN MÉMOIRE (à remplacer par DB en prod) ──
let profiles = [];
let queue = { status: 'idle', recipients: [], logs: [], sent: 0, failed: 0, total: 0 };

// ─────────────────────────────────────────────────────
// HELPER RESEND — envoi via API HTTPS (contourne le blocage SMTP de Render)
// ─────────────────────────────────────────────────────
async function sendViaResend({ apiKey, fromEmail, fromName, to, subject, text, html }) {
  if (!apiKey) throw new Error('Clé API Resend manquante');
  if (!fromEmail) throw new Error('From Email manquant (domaine vérifié Resend)');

  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  const payload = { from, to: [to], subject };
  if (html) payload.html = html;
  else payload.text = text || '';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return data; // { id: '...' }
}

// ─────────────────────────────────────────────────────
// HELPER SMTP — envoi via nodemailer
// ─────────────────────────────────────────────────────
async function sendViaSmtp({ smtp, fromEmail, fromName, to, subject, text, html }) {
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: parseInt(smtp.port),
    secure: smtp.secure === true,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });

  return transporter.sendMail({
    from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
    to,
    subject,
    text: html ? undefined : text,
    html: html ? html : undefined
  });
}

// ── PROFILS ──────────────────────────────────────────
app.get('/api/profiles', (req, res) => {
  res.json({ success: true, profiles });
});

app.post('/api/profiles', (req, res) => {
  const p = req.body;
  p.id = Date.now().toString();
  profiles.push(p);
  res.json({ success: true, profile: p });
});

app.delete('/api/profiles/:id', (req, res) => {
  profiles = profiles.filter(p => p.id !== req.params.id);
  res.json({ success: true });
});

app.post('/api/profiles/:id/test', async (req, res) => {
  try {
    const profile = profiles.find(p => p.id === req.params.id);
    if (!profile) return res.json({ success: false, error: 'Profil non trouvé' });

    const { testEmail } = req.body;
    if (!testEmail || !testEmail.includes('@')) {
      return res.json({ success: false, detail: 'Email de test invalide' });
    }

    const { mode, smtp, resendKey, fromEmail, fromName } = profile;

    if (mode === 'resend') {
      await sendViaResend({
        apiKey: resendKey,
        fromEmail,
        fromName,
        to: testEmail,
        subject: '🧪 Test SMTP Mailer',
        text: 'Cet email confirme que votre connexion Resend fonctionne parfaitement.'
      });
    } else {
      await sendViaSmtp({
        smtp,
        fromEmail,
        fromName,
        to: testEmail,
        subject: '🧪 Test SMTP Mailer',
        text: 'Cet email confirme que votre connexion SMTP fonctionne parfaitement.'
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, detail: err.message });
  }
});

// ── TEST DE CONNEXION ──────────────────────────────────
app.post('/api/test', async (req, res) => {
  try {
    const { mode, smtp, resendKey, fromEmail, fromName, testEmail } = req.body;

    if (!testEmail || !testEmail.includes('@')) {
      return res.json({ success: false, detail: 'Email de test invalide' });
    }

    if (mode === 'resend') {
      if (!resendKey) {
        return res.json({ success: false, detail: 'Clé API Resend manquante' });
      }
      if (!fromEmail) {
        return res.json({ success: false, detail: 'From Email manquant (domaine vérifié Resend)' });
      }

      await sendViaResend({
        apiKey: resendKey,
        fromEmail,
        fromName,
        to: testEmail,
        subject: '🧪 Test SMTP Mailer',
        text: 'Cet email confirme que votre connexion Resend fonctionne.'
      });
    } else {
      if (!smtp || !smtp.host || !smtp.port || !smtp.user || !smtp.pass) {
        return res.json({ success: false, detail: 'Config SMTP incomplète' });
      }

      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: parseInt(smtp.port),
        secure: smtp.secure === true,
        auth: { user: smtp.user, pass: smtp.pass },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
      });

      await transporter.verify();
      await transporter.sendMail({
        from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
        to: testEmail,
        subject: '🧪 Test SMTP Mailer',
        text: 'Cet email confirme que votre connexion SMTP fonctionne.'
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, detail: err.message });
  }
});

// ── QUEUE STATUS ────────────────────────────────────────
app.get('/api/queue/status', (req, res) => {
  const since = parseInt(req.query.since || 0);
  const newLogs = queue.logs.slice(since);

  res.json({
    status: queue.status,
    sent: queue.sent,
    failed: queue.failed,
    total: queue.total,
    newLogs,
    logCount: queue.logs.length,
    recipients: queue.recipients || []
  });
});

// ── START SEND ──────────────────────────────────────────
app.post('/api/queue/start', async (req, res) => {
  if (queue.status === 'running') {
    return res.json({ success: false, error: 'Un envoi est déjà en cours' });
  }

  queue = {
    status: 'running',
    mode: req.body.mode,
    smtp: req.body.smtp,
    resendKey: req.body.resendKey,
    fromEmail: req.body.fromEmail,
    fromName: req.body.fromName,
    mail: req.body.mail,
    recipients: req.body.recipients.map(r => ({ ...r, status: 'pending' })),
    delayMs: req.body.delayMs,
    sent: 0,
    failed: 0,
    total: req.body.recipients.length,
    logs: []
  };

  addQueueLog(`⚡ Envoi démarré — ${queue.total} destinataire(s) [${queue.mode}]`, 'success');
  res.json({ success: true });

  // Lance l'envoi en arrière-plan
  processQueue().catch(err => {
    addQueueLog(`Erreur: ${err.message}`, 'error');
    queue.status = 'error';
  });
});

async function processQueue() {
  // Pour le mode SMTP on réutilise un seul transporter (pool) : plus rapide, moins de timeouts
  let smtpTransporter = null;
  if (queue.mode !== 'resend') {
    smtpTransporter = nodemailer.createTransport({
      host: queue.smtp.host,
      port: parseInt(queue.smtp.port),
      secure: queue.smtp.secure === true,
      auth: { user: queue.smtp.user, pass: queue.smtp.pass },
      pool: true,
      maxConnections: 1,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
  }

  for (let i = 0; i < queue.recipients.length; i++) {
    if (queue.status === 'stopped') break;
    if (queue.status === 'paused') await waitForResume();

    const rec = queue.recipients[i];
    if (rec.status === 'sent') continue;

    try {
      rec.status = 'sending';
      const name = rec.name || rec.email.split('@')[0];
      const body = (queue.mail.body || '').replace(/{{name}}/g, name);

      if (queue.mode === 'resend') {
        await sendViaResend({
          apiKey: queue.resendKey,
          fromEmail: queue.fromEmail,
          fromName: queue.fromName,
          to: rec.email,
          subject: queue.mail.subject,
          text: queue.mail.html ? undefined : body,
          html: queue.mail.html ? body : undefined
        });
      } else {
        await smtpTransporter.sendMail({
          from: queue.fromName ? `"${queue.fromName}" <${queue.fromEmail}>` : queue.fromEmail,
          to: rec.email,
          subject: queue.mail.subject,
          text: queue.mail.html ? undefined : body,
          html: queue.mail.html ? body : undefined
        });
      }

      rec.status = 'sent';
      queue.sent++;
      addQueueLog(`✓ ${rec.email}`, 'success');
    } catch (err) {
      rec.status = 'error';
      queue.failed++;
      addQueueLog(`✗ ${rec.email} — ${err.message.substring(0, 80)}`, 'error');
    }

    // Délai avant le prochain email
    await new Promise(resolve => setTimeout(resolve, queue.delayMs));
  }

  if (smtpTransporter) smtpTransporter.close();

  queue.status = 'done';
  addQueueLog(`✅ Envoi terminé — ${queue.sent} réussi(s), ${queue.failed} échoué(s)`, 'success');
}

function waitForResume() {
  return new Promise(resolve => {
    const check = setInterval(() => {
      if (queue.status !== 'paused') {
        clearInterval(check);
        resolve();
      }
    }, 500);
  });
}

function addQueueLog(msg, level = 'info') {
  queue.logs.push({ msg, level, timestamp: new Date().toISOString() });
}

// ── PAUSE / RESUME / STOP ───────────────────────────────
app.post('/api/queue/pause', (req, res) => {
  if (queue.status === 'running') {
    queue.status = 'paused';
    addQueueLog('⏸ Envoi en pause', 'warn');
  }
  res.json({ success: true });
});

app.post('/api/queue/resume', (req, res) => {
  if (queue.status === 'paused') {
    queue.status = 'running';
    addQueueLog('▶ Envoi repris', 'info');
  }
  res.json({ success: true });
});

app.post('/api/queue/stop', (req, res) => {
  queue.status = 'stopped';
  addQueueLog('⏹ Envoi stoppé', 'warn');
  res.json({ success: true });
});

app.post('/api/queue/reset', (req, res) => {
  queue = { status: 'idle', recipients: [], logs: [], sent: 0, failed: 0, total: 0 };
  res.json({ success: true });
});

// ── ROUTE PAR DÉFAUT ────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── DÉMARRAGE DU SERVEUR ────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 SMTP Mailer lancé sur http://localhost:${PORT}\n`);
  console.log('   Frontend: http://localhost:' + PORT);
  console.log('   API: http://localhost:' + PORT + '/api/profiles\n');
});
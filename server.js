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
    const { mode, smtp, fromEmail, fromName } = profile;

    if (mode === 'smtp') {
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: parseInt(smtp.port),
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass }
      });

      await transporter.sendMail({
        from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
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
    const { mode, smtp, fromEmail, fromName, testEmail } = req.body;

    if (!testEmail || !testEmail.includes('@')) {
      return res.json({ success: false, detail: 'Email de test invalide' });
    }

    if (mode === 'smtp') {
      if (!smtp.host || !smtp.port || !smtp.user || !smtp.pass) {
        return res.json({ success: false, detail: 'Config SMTP incomplète' });
      }

      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: parseInt(smtp.port),
        secure: smtp.secure === true,
        auth: { user: smtp.user, pass: smtp.pass }
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

  addQueueLog(`⚡ Envoi démarré — ${queue.total} destinataire(s)`, 'success');
  res.json({ success: true });

  // Lance l'envoi en arrière-plan
  processQueue().catch(err => {
    addQueueLog(`Erreur: ${err.message}`, 'error');
    queue.status = 'error';
  });
});

async function processQueue() {
  for (let i = 0; i < queue.recipients.length; i++) {
    if (queue.status === 'stopped') break;
    if (queue.status === 'paused') await waitForResume();

    const rec = queue.recipients[i];
    if (rec.status === 'sent') continue;

    try {
      rec.status = 'sending';
      const body = queue.mail.body.replace(/{{name}}/g, rec.name || rec.email.split('@')[0]);

      const transporter = nodemailer.createTransport({
        host: queue.smtp.host,
        port: parseInt(queue.smtp.port),
        secure: queue.smtp.secure === true,
        auth: { user: queue.smtp.user, pass: queue.smtp.pass }
      });

      await transporter.sendMail({
        from: queue.fromName ? `"${queue.fromName}" <${queue.fromEmail}>` : queue.fromEmail,
        to: rec.email,
        subject: queue.mail.subject,
        text: queue.mail.html ? undefined : body,
        html: queue.mail.html ? body : undefined
      });

      rec.status = 'sent';
      queue.sent++;
      addQueueLog(`✓ ${rec.email}`, 'success');
    } catch (err) {
      rec.status = 'error';
      queue.failed++;
      addQueueLog(`✗ ${rec.email} — ${err.message.substring(0, 50)}`, 'error');
    }

    // Délai avant le prochain email
    await new Promise(resolve => setTimeout(resolve, queue.delayMs));
  }

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
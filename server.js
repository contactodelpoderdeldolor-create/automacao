const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Data storage paths
const DATA_DIR = path.join(__dirname, 'data');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'whatsapp_session.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');

// Ensure data directory and files exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, defaultVal) {
  try {
    if (!fs.existsSync(file)) return defaultVal;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return defaultVal; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Default config
const DEFAULT_CONFIG = {
  message: "Olá {nome}! 👋\n\nNotamos que você gerou um PIX mas ainda não finalizou o pagamento.\n\nClique no link abaixo para concluir sua compra:\n{link_pix}\n\nQualquer dúvida, estamos aqui! 😊",
  schedules: [
    { id: '15min', label: '15 minutos', minutes: 15, active: true },
    { id: '4h', label: '4 horas', minutes: 240, active: true },
    { id: '24h', label: '24 horas', minutes: 1440, active: false }
  ]
};

if (!fs.existsSync(CONFIG_FILE)) writeJSON(CONFIG_FILE, DEFAULT_CONFIG);
if (!fs.existsSync(PAYMENTS_FILE)) writeJSON(PAYMENTS_FILE, []);
if (!fs.existsSync(LOGS_FILE)) writeJSON(LOGS_FILE, []);

// WhatsApp state
let waConnected = false;
let waQR = null;
let waSock = null;
let waConnecting = false;

// =============================================================================
// WEBHOOK ENDPOINTS
// =============================================================================

// Kiwify webhook
app.post('/webhook/kiwify', (req, res) => {
  try {
    const body = req.body;
    console.log('Kiwify webhook received:', JSON.stringify(body).substring(0, 200));

    let pixData = null;

    // Kiwify PIX generated event
    if (body.order_status === 'waiting_payment' && body.payment?.method === 'pix') {
      pixData = {
        platform: 'kiwify',
        customer_name: body.Customer?.full_name || body.Customer?.name || 'Cliente',
        customer_phone: normalizePhone(body.Customer?.mobile || body.Customer?.phone || ''),
        pix_link: body.payment?.pix_qrcode || body.payment?.pix_link || body.checkout_url || '',
        order_id: body.order_id || uuidv4(),
        raw: body
      };
    }

    if (pixData) {
      registerPixPayment(pixData);
      return res.json({ success: true, message: 'PIX registrado' });
    }

    // Payment confirmed - mark as paid
    if (body.order_status === 'paid' || body.order_status === 'approved') {
      markAsPaid(body.order_id);
    }

    res.json({ success: true, message: 'Evento recebido' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Hotmart webhook
app.post('/webhook/hotmart', (req, res) => {
  try {
    const body = req.body;
    console.log('Hotmart webhook received:', JSON.stringify(body).substring(0, 200));

    const event = body.event;
    const data = body.data || {};

    // Hotmart PIX generated
    if (event === 'PURCHASE_BILLET_PRINTED' || (event === 'PURCHASE_WAITING_PAYMENT' && data.payment?.type === 'PIX')) {
      const buyer = data.buyer || {};
      const pixData = {
        platform: 'hotmart',
        customer_name: buyer.name || 'Cliente',
        customer_phone: normalizePhone(buyer.phone || ''),
        pix_link: data.payment?.pix_link || data.payment?.pix_qrcode || data.checkout_url || '',
        order_id: data.purchase?.transaction || uuidv4(),
        raw: body
      };
      registerPixPayment(pixData);
      return res.json({ success: true, message: 'PIX registrado' });
    }

    if (event === 'PURCHASE_APPROVED' || event === 'PURCHASE_COMPLETE') {
      const orderId = data.purchase?.transaction;
      if (orderId) markAsPaid(orderId);
    }

    res.json({ success: true, message: 'Evento recebido' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Generic / test webhook
app.post('/webhook/test', (req, res) => {
  try {
    const body = req.body;
    const pixData = {
      platform: 'test',
      customer_name: body.customer_name || body.nome || 'Cliente Teste',
      customer_phone: normalizePhone(body.customer_phone || body.telefone || '5548999999999'),
      pix_link: body.pix_link || body.link_pix || 'https://pix.example.com/pay/test123',
      order_id: body.order_id || uuidv4(),
      raw: body
    };
    const payment = registerPixPayment(pixData);
    res.json({ success: true, message: 'PIX de teste registrado', payment_id: payment.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

function registerPixPayment(data) {
  const payments = readJSON(PAYMENTS_FILE, []);
  
  // Check if order already exists
  const existing = payments.find(p => p.order_id === data.order_id);
  if (existing) return existing;

  const payment = {
    id: uuidv4(),
    order_id: data.order_id,
    platform: data.platform,
    customer_name: data.customer_name,
    customer_phone: data.customer_phone,
    pix_link: data.pix_link,
    status: 'pending',
    created_at: new Date().toISOString(),
    messages_sent: [],
    replied: false,
    scheduled_sends: []
  };

  // Schedule messages
  const config = readJSON(CONFIG_FILE, DEFAULT_CONFIG);
  const now = Date.now();
  
  config.schedules.filter(s => s.active).forEach(schedule => {
    payment.scheduled_sends.push({
      schedule_id: schedule.id,
      label: schedule.label,
      send_at: new Date(now + schedule.minutes * 60 * 1000).toISOString(),
      sent: false
    });
  });

  payments.push(payment);
  writeJSON(PAYMENTS_FILE, payments);
  
  addLog('info', `PIX registrado: ${data.customer_name} (${data.platform})`);
  console.log(`PIX registered: ${data.customer_name} - ${data.order_id}`);
  
  return payment;
}

function markAsPaid(orderId) {
  const payments = readJSON(PAYMENTS_FILE, []);
  const idx = payments.findIndex(p => p.order_id === orderId);
  if (idx !== -1) {
    payments[idx].status = 'paid';
    payments[idx].paid_at = new Date().toISOString();
    writeJSON(PAYMENTS_FILE, payments);
    addLog('success', `PIX pago: ${payments[idx].customer_name}`);
  }
}

function addLog(type, message) {
  const logs = readJSON(LOGS_FILE, []);
  logs.unshift({ id: uuidv4(), type, message, timestamp: new Date().toISOString() });
  if (logs.length > 500) logs.splice(500);
  writeJSON(LOGS_FILE, logs);
}

// =============================================================================
// SCHEDULER
// =============================================================================

async function runScheduler() {
  const payments = readJSON(PAYMENTS_FILE, []);
  const config = readJSON(CONFIG_FILE, DEFAULT_CONFIG);
  const now = new Date();
  let changed = false;

  for (const payment of payments) {
    if (payment.status !== 'pending' || payment.replied) continue;
    if (!payment.customer_phone) continue;

    for (const sched of (payment.scheduled_sends || [])) {
      if (sched.sent) continue;
      if (new Date(sched.send_at) <= now) {
        sched.sent = true;
        sched.sent_at = now.toISOString();
        changed = true;

        const message = config.message
          .replace(/{nome}/g, payment.customer_name)
          .replace(/{link_pix}/g, payment.pix_link);

        const success = await sendWhatsAppMessage(payment.customer_phone, message);
        
        payment.messages_sent.push({
          schedule_id: sched.schedule_id,
          label: sched.label,
          sent_at: now.toISOString(),
          success,
          message
        });

        addLog(success ? 'success' : 'error', 
          `Mensagem ${sched.label} ${success ? 'enviada' : 'falhou'} para ${payment.customer_name}`);
      }
    }
  }

  if (changed) writeJSON(PAYMENTS_FILE, payments);
}

// Run scheduler every minute
setInterval(runScheduler, 60 * 1000);

// =============================================================================
// WHATSAPP
// =============================================================================

async function sendWhatsAppMessage(phone, message) {
  if (!waConnected || !waSock) {
    console.log(`[WA] Not connected, cannot send to ${phone}`);
    return false;
  }

  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await waSock.sendMessage(jid, { text: message });
    console.log(`[WA] Message sent to ${phone}`);
    return true;
  } catch (err) {
    console.error(`[WA] Send error to ${phone}:`, err.message);
    return false;
  }
}

async function startWhatsApp() {
  if (waConnecting) return;
  waConnecting = true;
  waConnected = false;
  waQR = null;

  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = await import('@whiskeysockets/baileys');
    const { Boom } = await import('@hapi/boom');
    const pino = (await import('pino')).default;

    const authDir = path.join(DATA_DIR, 'wa_auth');
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const logger = pino({ level: 'silent' });

    waSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Desktop'),
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 3,
      getMessage: async () => { return { conversation: '' }; }
    });

    waSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const QRCode = await import('qrcode');
        waQR = await QRCode.default.toDataURL(qr);
        waConnected = false;
        console.log('[WA] QR Code generated');
      }

      if (connection === 'open') {
        waConnected = true;
        waQR = null;
        waConnecting = false;
        addLog('success', 'WhatsApp conectado com sucesso');
        console.log('[WA] Connected!');
      }

      if (connection === 'close') {
        waConnected = false;
        waConnecting = false;
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log('[WA] Connection closed. Reason:', reason);

        if (reason === DisconnectReason.loggedOut) {
          // Clear auth and don't reconnect automatically
          const authDir = path.join(DATA_DIR, 'wa_auth');
          if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
          }
          addLog('warning', 'WhatsApp desconectado (logout)');
          waSock = null;
        } else if (reason !== DisconnectReason.connectionClosed) {
          // Reconnect after delay
          setTimeout(() => { waConnecting = false; startWhatsApp(); }, 5000);
          addLog('warning', 'WhatsApp reconectando...');
        }
      }
    });

    waSock.ev.on('creds.update', saveCreds);

    // Listen for incoming messages (stop automation if customer replies)
    waSock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const senderPhone = msg.key.remoteJid?.replace('@s.whatsapp.net', '').replace('@g.us', '');
        if (!senderPhone) continue;

        const payments = readJSON(PAYMENTS_FILE, []);
        const idx = payments.findIndex(p => p.customer_phone === senderPhone && p.status === 'pending');
        if (idx !== -1 && !payments[idx].replied) {
          payments[idx].replied = true;
          payments[idx].replied_at = new Date().toISOString();
          writeJSON(PAYMENTS_FILE, payments);
          addLog('info', `Cliente ${payments[idx].customer_name} respondeu — automação pausada`);
        }
      }
    });

  } catch (err) {
    waConnecting = false;
    console.error('[WA] Init error:', err.message);
    addLog('error', `Erro ao iniciar WhatsApp: ${err.message}`);
  }
}

// =============================================================================
// API ROUTES
// =============================================================================

// Dashboard stats
app.get('/api/stats', (req, res) => {
  const payments = readJSON(PAYMENTS_FILE, []);
  const logs = readJSON(LOGS_FILE, []);
  
  const total = payments.length;
  const paid = payments.filter(p => p.status === 'paid').length;
  const pending = payments.filter(p => p.status === 'pending').length;
  const messagesSent = payments.reduce((acc, p) => acc + (p.messages_sent?.filter(m => m.success).length || 0), 0);
  
  res.json({ total, paid, pending, messagesSent, logs: logs.slice(0, 20) });
});

// Payments list
app.get('/api/payments', (req, res) => {
  const payments = readJSON(PAYMENTS_FILE, []);
  res.json(payments.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

// Delete payment
app.delete('/api/payments/:id', (req, res) => {
  let payments = readJSON(PAYMENTS_FILE, []);
  payments = payments.filter(p => p.id !== req.params.id);
  writeJSON(PAYMENTS_FILE, payments);
  res.json({ success: true });
});

// Config
app.get('/api/config', (req, res) => {
  res.json(readJSON(CONFIG_FILE, DEFAULT_CONFIG));
});

app.post('/api/config', (req, res) => {
  const current = readJSON(CONFIG_FILE, DEFAULT_CONFIG);
  const updated = { ...current, ...req.body };
  writeJSON(CONFIG_FILE, updated);
  addLog('info', 'Configurações atualizadas');
  res.json({ success: true, config: updated });
});

// WhatsApp status
app.get('/api/whatsapp/status', (req, res) => {
  res.json({ connected: waConnected, qr: waQR, connecting: waConnecting });
});

app.post('/api/whatsapp/connect', async (req, res) => {
  startWhatsApp();
  res.json({ success: true, message: 'Iniciando conexão...' });
});

app.post('/api/whatsapp/disconnect', (req, res) => {
  if (waSock) {
    waSock.logout();
    waSock = null;
  }
  waConnected = false;
  waQR = null;
  waConnecting = false;
  
  // Clear auth
  const authDir = path.join(DATA_DIR, 'wa_auth');
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
  addLog('info', 'WhatsApp desconectado manualmente');
  res.json({ success: true });
});

// Send test message
app.post('/api/whatsapp/test', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone e message são obrigatórios' });
  const success = await sendWhatsAppMessage(phone, message);
  res.json({ success });
});

// Logs
app.get('/api/logs', (req, res) => {
  res.json(readJSON(LOGS_FILE, []));
});

// Webhook info
app.get('/api/webhook-info', (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  res.json({
    kiwify: `${protocol}://${host}/webhook/kiwify`,
    hotmart: `${protocol}://${host}/webhook/hotmart`,
    test: `${protocol}://${host}/webhook/test`
  });
});

// Try to reconnect on startup if auth exists
const authDir = path.join(DATA_DIR, 'wa_auth');
if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
  console.log('[WA] Auth found, reconnecting...');
  setTimeout(startWhatsApp, 2000);
}

app.listen(PORT, () => {
  console.log(`\n🚀 PIX Recovery Server rodando em http://localhost:${PORT}`);
  console.log(`📱 Webhooks:`);
  console.log(`   Kiwify : http://localhost:${PORT}/webhook/kiwify`);
  console.log(`   Hotmart: http://localhost:${PORT}/webhook/hotmart`);
  console.log(`   Teste  : http://localhost:${PORT}/webhook/test`);
  console.log(`\n📊 Painel: http://localhost:${PORT}\n`);
});

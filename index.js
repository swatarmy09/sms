require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = JSON.parse(process.env.ADMIN_IDS || '[]'); // Ensure it's an array

if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is not set in .env file!');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

app.use(bodyParser.json());

// In-memory store for connected devices
// In a real application, this would be a database
const connectedDevices = {}; // deviceId -> { socketId, info, lastSeen, telegramChatId }

// --- Socket.IO for Android App Communication ---
io.on('connection', (socket) => {
    console.log('A new Android device connected:', socket.id);

    socket.on('register_device', (deviceInfo) => {
        const deviceId = deviceInfo.deviceId; // Unique ID from Android app
        connectedDevices[deviceId] = {
            socketId: socket.id,
            info: deviceInfo,
            lastSeen: Date.now(),
            telegramChatId: null // Will be set when user links device
        };
        console.log(`Device registered: ${deviceId}`);
        // Notify admin about new device connection
        ADMIN_IDS.forEach(adminId => {
            bot.sendMessage(adminId, `New device connected: ${deviceInfo.deviceName} (${deviceInfo.deviceId})\nSIM: ${deviceInfo.simNumber}\nBattery: ${deviceInfo.batteryLevel}%`);
        });
        socket.emit('device_registered', { status: 'success', deviceId: deviceId });
    });

    socket.on('device_update', (deviceInfo) => {
        const deviceId = deviceInfo.deviceId;
        if (connectedDevices[deviceId]) {
            connectedDevices[deviceId].info = { ...connectedDevices[deviceId].info, ...deviceInfo };
            connectedDevices[deviceId].lastSeen = Date.now();
            console.log(`Device updated: ${deviceId}`);
        }
    });

    socket.on('sms_received', (data) => {
        const { deviceId, sender, message, simSlot } = data;
        console.log(`SMS received from ${deviceId} (SIM ${simSlot}): ${sender} - ${message}`);
        if (connectedDevices[deviceId] && connectedDevices[deviceId].telegramChatId) {
            bot.sendMessage(connectedDevices[deviceId].telegramChatId, `SMS from ${sender} (SIM ${simSlot} on ${connectedDevices[deviceId].info.deviceName}): ${message}`);
        }
        // TODO: Implement SMS forwarding logic here if enabled for this device
    });

    socket.on('sms_sent_status', (data) => {
        const { deviceId, status, messageId, error } = data;
        console.log(`SMS sent status from ${deviceId}: ${status}`);
        if (connectedDevices[deviceId] && connectedDevices[deviceId].telegramChatId) {
            let response = `SMS send status for ${connectedDevices[deviceId].info.deviceName}: ${status}`;
            if (error) response += `\nError: ${error}`;
            bot.sendMessage(connectedDevices[deviceId].telegramChatId, response);
        }
    });

    socket.on('list_sms_response', (data) => {
        const { deviceId, simSlot, messages } = data;
        console.log(`Received SMS list from ${deviceId} (SIM ${simSlot})`);
        if (connectedDevices[deviceId] && connectedDevices[deviceId].telegramChatId) {
            let response = `Last 10 SMS from ${connectedDevices[deviceId].info.deviceName} (SIM ${simSlot}):\n`;
            if (messages.length === 0) {
                response += "No messages found.";
            } else {
                messages.forEach(msg => {
                    response += `\nFrom: ${msg.sender}\nMessage: ${msg.body}\nDate: ${new Date(msg.timestamp).toLocaleString()}\n---`;
                });
            }
            bot.sendMessage(connectedDevices[deviceId].telegramChatId, response);
        }
    });

    socket.on('disconnect', () => {
        console.log('An Android device disconnected:', socket.id);
        for (const deviceId in connectedDevices) {
            if (connectedDevices[deviceId].socketId === socket.id) {
                console.log(`Device ${deviceId} disconnected.`);
                // Optionally notify admin
                if (connectedDevices[deviceId].telegramChatId) {
                    bot.sendMessage(connectedDevices[deviceId].telegramChatId, `Your device ${connectedDevices[deviceId].info.deviceName} has disconnected.`);
                }
                delete connectedDevices[deviceId];
                break;
            }
        }
    });
});

// --- Telegram Bot Commands ---

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Welcome! Use /connect to link your device or /help for commands.');
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    let helpMessage = `
Available commands:
/start - Welcome message
/connect <deviceId> - Link your Telegram chat to a specific device ID (from Android app)
/devices - List all connected devices
/send_sms <deviceId> <simSlot> <phoneNumber> <message> - Send an SMS
/get_sms <deviceId> <simSlot> - Get last 10 SMS from a SIM
/forward_sms <deviceId> <enable|disable> [forwardNumber] - Manage SMS forwarding
    `;
    bot.sendMessage(chatId, helpMessage);
});

bot.onText(/\/connect (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const deviceId = match[1].trim();

    if (connectedDevices[deviceId]) {
        connectedDevices[deviceId].telegramChatId = chatId;
        bot.sendMessage(chatId, `Successfully linked to device: ${connectedDevices[deviceId].info.deviceName} (${deviceId})`);
        // Send a message to the device to confirm connection
        io.to(connectedDevices[deviceId].socketId).emit('telegram_linked', { chatId: chatId });
    } else {
        bot.sendMessage(chatId, `Device ID "${deviceId}" not found or not connected. Make sure your Android app is running and registered.`);
    }
});

bot.onText(/\/devices/, (msg) => {
    const chatId = msg.chat.id;
    let deviceList = 'Connected Devices:\n';
    let foundDevices = false;
    for (const deviceId in connectedDevices) {
        foundDevices = true;
        const device = connectedDevices[deviceId];
        deviceList += `\nID: ${deviceId}\nName: ${device.info.deviceName}\nSIM: ${device.info.simNumber}\nBattery: ${device.info.batteryLevel}%\nLast Seen: ${new Date(device.lastSeen).toLocaleString()}\n`;
        if (device.telegramChatId === chatId) {
            deviceList += `(Linked to your chat)\n`;
        } else if (device.telegramChatId) {
            deviceList += `(Linked to another chat)\n`;
        } else {
            deviceList += `(Not linked to any chat)\n`;
        }
    }
    if (!foundDevices) {
        deviceList = 'No devices currently connected.';
    }
    bot.sendMessage(chatId, deviceList);
});

bot.onText(/\/send_sms (.+) (.+) (.+) (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const deviceId = match[1];
    const simSlot = match[2];
    const phoneNumber = match[3];
    const message = match[4];

    if (!connectedDevices[deviceId] || connectedDevices[deviceId].telegramChatId !== chatId) {
        bot.sendMessage(chatId, `Device ${deviceId} not found or not linked to your chat.`);
        return;
    }

    if (!['1', '2'].includes(simSlot)) {
        bot.sendMessage(chatId, 'Invalid SIM slot. Use 1 or 2.');
        return;
    }

    // Request Android app to send SMS
    io.to(connectedDevices[deviceId].socketId).emit('send_sms', {
        phoneNumber: phoneNumber,
        message: message,
        simSlot: parseInt(simSlot)
    });
    bot.sendMessage(chatId, `Request to send SMS to ${phoneNumber} via ${connectedDevices[deviceId].info.deviceName} (SIM ${simSlot}) sent.`);
});

bot.onText(/\/get_sms (.+) (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const deviceId = match[1];
    const simSlot = match[2];

    if (!connectedDevices[deviceId] || connectedDevices[deviceId].telegramChatId !== chatId) {
        bot.sendMessage(chatId, `Device ${deviceId} not found or not linked to your chat.`);
        return;
    }

    if (!['1', '2'].includes(simSlot)) {
        bot.sendMessage(chatId, 'Invalid SIM slot. Use 1 or 2.');
        return;
    }

    // Request Android app to list SMS
    io.to(connectedDevices[deviceId].socketId).emit('list_sms', {
        simSlot: parseInt(simSlot)
    });
    bot.sendMessage(chatId, `Request to get last 10 SMS from ${connectedDevices[deviceId].info.deviceName} (SIM ${simSlot}) sent.`);
});

bot.onText(/\/forward_sms (.+) (enable|disable)(?: (.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const deviceId = match[1];
    const action = match[2]; // 'enable' or 'disable'
    const forwardNumber = match[3]; // Optional for 'enable'

    if (!connectedDevices[deviceId] || connectedDevices[deviceId].telegramChatId !== chatId) {
        bot.sendMessage(chatId, `Device ${deviceId} not found or not linked to your chat.`);
        return;
    }

    if (action === 'enable' && !forwardNumber) {
        bot.sendMessage(chatId, 'Please provide a forward number when enabling SMS forwarding. Usage: /forward_sms <deviceId> enable <forwardNumber>');
        return;
    }

    // Request Android app to manage SMS forwarding
    io.to(connectedDevices[deviceId].socketId).emit('manage_sms_forwarding', {
        action: action,
        forwardNumber: forwardNumber
    });
    bot.sendMessage(chatId, `Request to ${action} SMS forwarding on ${connectedDevices[deviceId].info.deviceName} sent.`);
});


// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Telegram Bot started. Send /start to your bot.');
});

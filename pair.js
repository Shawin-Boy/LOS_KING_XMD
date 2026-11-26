const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { sms, downloadMediaMessage } = require('./lib/msg');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

const FIREBASE_URL = 'https://shavin-boy-default-rtdb.asia-southeast1.firebasedatabase.app';

const config = {
    BOT_NAME: 'LOS-KING-XMD',
    BOT_FOOTER: 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʟᴏs-ᴋɪɴɢ-xᴍᴅ | © sʜᴀᴡɪɴ ʙᴏʏ',
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/EcdBBy3QirjBZy7B35BXc7?s=cl&p=a&iam=2',
    RCD_IMAGE_PATH: './media/1000558702.jpg',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94757010954'
};

function getImagePayload(imagePath) {
    if (!imagePath) return undefined;
    if (/^https?:\/\//i.test(imagePath)) {
        return { url: imagePath };
    }
    const resolvedPath = path.resolve(imagePath);
    if (fs.existsSync(resolvedPath)) {
        return fs.readFileSync(resolvedPath);
    }
    console.warn(`⚠️ Image not found at path: ${resolvedPath}`);
    return undefined;
}

function extractInviteCode(inviteLink) {
    if (!inviteLink || typeof inviteLink !== 'string') return null;
    const match = inviteLink.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
}

async function joinGroupFromConfig(socket, inviteLink) {
    const code = extractInviteCode(inviteLink);
    if (!code) {
        console.warn('⚠️ Invalid or missing GROUP_INVITE_LINK');
        return;
    }
    try {
        await socket.groupAcceptInvite(code);
        console.log(`✅ Joined group with invite code: ${code}`);
    } catch (error) {
        console.warn(`⚠️ Could not auto-join group (${code}):`, error.message || error);
    }
}

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

function getUptimeFormatted(number) {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = Math.floor(uptimeSec % 60);
    return `${hours}h ${minutes}m ${seconds}s`;
}

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        if (!data) return;

        const sessionKeys = Object.keys(data).filter(
            key => key.startsWith(`empire_${sanitizedNumber}_`) && key.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        if (sessionKeys.length > 1) {
            for (let i = 1; i < sessionKeys.length; i++) {
                await axios.delete(`${FIREBASE_URL}/session/${sessionKeys[i].replace('.json', '')}.json`);
                console.log(`Deleted duplicate session file: ${sessionKeys[i]}`);
            }
        }

        const configKey = `config_${sanitizedNumber}.json`;
        if (data[configKey]) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        config.BOT_FOOTER
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();

        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            config.BOT_FOOTER
        );

        try {
            const imagePayload = getImagePayload(config.RCD_IMAGE_PATH);
            if (imagePayload) {
                await socket.sendMessage(userJid, {
                    image: imagePayload,
                    caption: message
                });
            } else {
                await socket.sendMessage(userJid, { text: message });
            }
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function fetchAiReply(prompt, mode = 'normal') {
    const prefixMap = {
        short: 'Reply shortly and directly: ',
        code: 'Provide clean, well-commented code and brief explanation for: ',
        translate: 'Translate accurately (detect language or translate to Sinhala/English clearly): ',
        explain: 'Explain clearly step by step: ',
        normal: ''
    };
    const finalPrompt = `${prefixMap[mode] || ''}${prompt}`;
    const encodedPrompt = encodeURIComponent(finalPrompt);

    try {
        const response = await axios.get(`https://text.pollinations.ai/${encodedPrompt}`, { timeout: 25000 });
        const text = typeof response.data === 'string'
            ? response.data.trim()
            : (response.data?.reply || response.data?.response || response.data?.result || '').toString().trim();
        if (text) return text;
    } catch (err) {
        console.warn(`AI request failed:`, err.message);
    }
    return null;
}

function extractMediaFromApiResponse(payload, type = 'audio') {
    if (!payload) return null;
    const data = payload.data || payload.result || payload;

    if (typeof data === 'string' && /^https?:\/\//i.test(data)) {
        return { url: data, title: 'Media' };
    }

    const title = data?.title || payload?.title || data?.desc || 'Media';
    const candidates = type === 'audio'
        ? [data?.audio, data?.mp3, data?.download, data?.url, data?.link, data?.music]
        : [data?.video, data?.mp4, data?.play, data?.hdplay, data?.download, data?.url, data?.link];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
            return { url: candidate, title };
        }
        if (Array.isArray(candidate)) {
            const found = candidate.find(item => typeof item === 'string' && /^https?:\/\//i.test(item))
                || candidate.find(item => item && typeof item.url === 'string' && /^https?:\/\//i.test(item.url));
            if (found) {
                return { url: typeof found === 'string' ? found : found.url, title };
            }
        }
    }
    return null;
}

async function fetchMediaByQuery(query, type = 'song') {
    const encoded = encodeURIComponent(query);
    const endpoints = type === 'song'
        ? [
            `https://api.siputzx.my.id/api/d/ytmp3?url=${encoded}`,
            `https://api.davidcyriltech.my.id/download/ytmp3?url=${encoded}`
        ]
        : type === 'video'
            ? [
                `https://api.siputzx.my.id/api/d/ytmp4?url=${encoded}`,
                `https://api.davidcyriltech.my.id/download/ytmp4?url=${encoded}`
            ]
            : type === 'fb'
                ? [
                    `https://api.siputzx.my.id/api/d/fbdl?url=${encoded}`,
                    `https://api.davidcyriltech.my.id/download/fb?url=${encoded}`
                ]
                : type === 'insta'
                    ? [
                        `https://api.siputzx.my.id/api/d/igdl?url=${encoded}`,
                        `https://api.davidcyriltech.my.id/download/ig?url=${encoded}`
                    ]
                    : [
                        `https://www.tikwm.com/api/?url=${encoded}`,
                        `https://api.siputzx.my.id/api/d/tiktok?url=${encoded}`
                    ];

    const mediaKind = type === 'song' ? 'audio' : 'video';
    for (const endpoint of endpoints) {
        try {
            const res = await axios.get(endpoint, { timeout: 25000 });
            const extracted = extractMediaFromApiResponse(res.data, mediaKind);
            if (extracted?.url) return extracted;
        } catch (err) {
            console.warn(`Media fetch failed (${type}) for ${endpoint}:`, err.message);
        }
    }
    return null;
}

function resolveTargetJid(m, argsText) {
    const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid;
    if (Array.isArray(mentioned) && mentioned.length > 0) {
        return mentioned[0];
    }

    const quotedParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
    if (quotedParticipant) {
        return quotedParticipant;
    }

    const digits = (argsText || '').replace(/[^0-9]/g, '');
    if (digits.length >= 7) {
        return `${digits}@s.whatsapp.net`;
    }

    return m.chat;
}

function safeMathEval(expr) {
    const cleaned = (expr || '').replace(/[^0-9+\-*/().%\s]/g, '').trim();
    if (!cleaned) return null;
    try {
        const result = Function(`"use strict"; return (${cleaned});`)();
        if (typeof result === 'number' && Number.isFinite(result)) {
            return String(result);
        }
    } catch (_) {
        return null;
    }
    return null;
}

function transformTextStyle(text, style) {
    const map = {
        upper: text.toUpperCase(),
        lower: text.toLowerCase(),
        reverse: text.split('').reverse().join(''),
        spacing: text.split('').join(' '),
        dash: text.split('').join('-'),
        dot: text.split('').join('.'),
        slash: text.split('').join('/'),
        bubble: text.replace(/[A-Za-z]/g, ch => {
            const code = ch.charCodeAt(0);
            if (code >= 65 && code <= 90) return String.fromCodePoint(0x24B6 + (code - 65));
            if (code >= 97 && code <= 122) return String.fromCodePoint(0x24D0 + (code - 97));
            return ch;
        }),
        boldsans: text.replace(/[A-Za-z]/g, ch => {
            const code = ch.charCodeAt(0);
            if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
            if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + (code - 97));
            return ch;
        }),
        italic: text.replace(/[A-Za-z]/g, ch => {
            const code = ch.charCodeAt(0);
            if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D608 + (code - 65));
            if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D622 + (code - 97));
            return ch;
        }),
        monospace: `\`${text}\``
    };
    return map[style] || text;
}

const SAFE_COMMANDS = [
    // 1 - 15: Main & System Info
    'menu', 'help', 'alive', 'aliven', 'ping', 'runtime', 'uptime', 'botinfo',
    'owner', 'creator', 'prefix', 'status', 'info', 'time', 'timenow',
    // 16 - 28: Date, Math & Unit Converters
    'date', 'year', 'month', 'day', 'calc', 'calculate', 'add', 'sub',
    'mul', 'div', 'percent', 'ctof', 'ftoc',
    // 29 - 45: Text Styling & String Tools
    'upper', 'lower', 'reverse', 'spacing', 'dash', 'dot', 'slash', 'bubble',
    'boldsans', 'italic', 'mono', 'len', 'wordcount', 'trim', 'slug', 'titlecase',
    'capitalize',
    // 46 - 58: Encoding, Hashing & Generators
    'base64', 'unbase64', 'hex', 'unhex', 'binary', 'urlencode', 'urldecode',
    'md5', 'sha256', 'uuid', 'password', 'randomnum', 'coinflip',
    // 59 - 72: AI Chat Commands
    'ai', 'ai2', 'gpt', 'gemini', 'ask', 'explain', 'code', 'translate',
    'summary', 'grammar', 'idea', 'poem', 'story', 'advisor',
    // 73 - 85: Media & Downloaders (Safe public media)
    'song', 'audio', 'play', 'video', 'mp4', 'tt', 'tiktok', 'fb',
    'facebook', 'insta', 'instagram', 'getdp', 'dp',
    // 86 - 102: Fun, Quotes, Facts & Motivation
    'quote', 'quotes', 'fact', 'facts', 'joke', 'jokes', 'riddle', 'motivation',
    'wisdom', 'proverb', 'compliment', '8ball', 'rate', 'pick', 'ship',
    'roll', 'dice',
    // 103 - 125: Knowledge, Study & Productivity
    'define', 'meaning', 'synonym', 'antonym', 'acronym', 'mathfact', 'trivia',
    'checklist', 'todo', 'note', 'remind', 'pomodoro', 'studyplan', 'flashcard',
    'quiz', 'factcheck', 'tip', 'techtip', 'lifehack', 'book', 'movieidea',
    'traveltip', 'healthytip',
    // 126 - 150: Group & Chat Utilities (Safe informational/moderation helpers)
    'jid', 'chatinfo', 'groupinfo', 'admins', 'members', 'link', 'botname',
    'footer', 'version', 'rules', 'welcome', 'goodbye', 'pingcheck', 'server',
    'memory', 'nodever', 'tz', 'colombo', 'utc', 'iso', 'epoch', 'age',
    'bmi', 'tipcalc', 'discount',
    // 151 - 166: Additional Useful Commands
    'ytsearch', 'yts', 'img', 'qr', 'shorten', 'weather', 'translate_si',
    'translate_en', 'sinhala', 'codefix', 'notes_help', 'botping', 'bio',
    'support', 'clear_cache', 'allcmds'
];

function buildCategorizedMenu(number) {
    const p = config.PREFIX;
    const chunks = [];
    for (let i = 0; i < SAFE_COMMANDS.length; i += 25) {
        const part = SAFE_COMMANDS.slice(i, i + 25).map(c => `\`${p}${c}\``).join(' • ');
        chunks.push(`*Part ${Math.floor(i / 25) + 1}*\n${part}`);
    }

    const header = [
        `❖ ── ✦ *${config.BOT_NAME} SAFE SUITE* ✦ ── ❖`,
        ``,
        `╔═════ ⌈ *👑 BOT INFO* ⌋ ═════✧`,
        `║ 🚀 *OWNER:* SHAWIN BOY`,
        `║ 🔢 *NUMBER:* ${number}`,
        `║ 📂 *COMMANDS:* ${SAFE_COMMANDS.length}`,
        `║ ⏱️ *UPTIME:* ${getUptimeFormatted(number)}`,
        `║ ⚡ *PREFIX:* [ ${p} ]`,
        `║ 🛡️ *PRIVACY:* SAFE & PROTECTED`,
        `╚══════════════════════✧`,
        ``
    ].join('\n');

    return `${header}${chunks.join('\n\n')}\n\n> *${config.BOT_FOOTER}*`;
}

async function handleSafeCommand(socket, number, m, command, argsText) {
    const p = config.PREFIX;
    const numArgs = argsText.split(/\s+/).map(Number).filter(n => !Number.isNaN(n));

    if (command === 'menu' || command === 'help') {
        await m.react('📜');
        const menuText = buildCategorizedMenu(number);
        const imagePayload = getImagePayload(config.RCD_IMAGE_PATH);
        if (imagePayload) {
            await socket.sendMessage(m.chat, { image: imagePayload, caption: menuText }, { quoted: m });
        } else {
            await m.reply(menuText);
        }
        return;
    }

    if (command === 'alive' || command === 'aliven') {
        await m.react('⚡');
        const aliveText = formatMessage(
            `⚡ ${config.BOT_NAME} IS ALIVE`,
            `🟢 *Status:* Online & Active\n👑 *Owner:* Shawin Boy\n📂 *Commands:* ${SAFE_COMMANDS.length}\n⏱️ *Uptime:* ${getUptimeFormatted(number)}\n🕒 *Time:* ${getSriLankaTimestamp()}`,
            config.BOT_FOOTER
        );
        const imagePayload = getImagePayload(config.RCD_IMAGE_PATH);
        if (imagePayload) {
            await socket.sendMessage(m.chat, { image: imagePayload, caption: aliveText }, { quoted: m });
        } else {
            await m.reply(aliveText);
        }
        return;
    }

    if (command === 'ping' || command === 'pingcheck') {
        const start = Date.now();
        await m.react('🏓');
        await m.reply(formatMessage('🏓 PONG!', `⚡ *Latency:* ${Date.now() - start}ms\n⏱️ *Uptime:* ${getUptimeFormatted(number)}`, config.BOT_FOOTER));
        return;
    }

    if (command === 'uptime' || command === 'runtime') {
        await m.reply(formatMessage('⏱️ RUNTIME', `🟢 *Uptime:* ${getUptimeFormatted(number)}\n🕒 *Time:* ${getSriLankaTimestamp()}`, config.BOT_FOOTER));
        return;
    }

    if (command === 'botinfo' || command === 'info' || command === 'status') {
        await m.reply(formatMessage(
            `🤖 ${config.BOT_NAME} INFO`,
            `• *Number:* ${number}\n• *Prefix:* ${p}\n• *Total Safe Commands:* ${SAFE_COMMANDS.length}\n• *Uptime:* ${getUptimeFormatted(number)}\n• *Time:* ${getSriLankaTimestamp()}`,
            config.BOT_FOOTER
        ));
        return;
    }

    if (command === 'owner' || command === 'creator') {
        await m.reply(formatMessage('👑 BOT OWNER', `• *Owner:* Shawin Boy\n• *Contact:* ${config.OWNER_NUMBER}`, config.BOT_FOOTER));
        return;
    }

    if (command === 'prefix') {
        await m.reply(formatMessage('⚡ PREFIX', `Current prefix is: *${p}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'botname') {
        await m.reply(formatMessage('🤖 BOT NAME', config.BOT_NAME, config.BOT_FOOTER));
        return;
    }

    if (command === 'footer') {
        await m.reply(formatMessage('🔖 BOT FOOTER', config.BOT_FOOTER, config.BOT_FOOTER));
        return;
    }

    if (command === 'version') {
        await m.reply(formatMessage('📌 VERSION', `${config.BOT_NAME} — v7.0.0 (Safe Suite)`, config.BOT_FOOTER));
        return;
    }

    if (command === 'rules') {
        await m.reply(formatMessage('🛡️ USAGE RULES', `1. Use commands responsibly.\n2. Avoid spam or abusive messages.\n3. Respect privacy and WhatsApp policies.`, config.BOT_FOOTER));
        return;
    }

    if (command === 'welcome') {
        await m.reply(formatMessage('👋 WELCOME', `Welcome! Type *${p}menu* to see all ${SAFE_COMMANDS.length} commands.`, config.BOT_FOOTER));
        return;
    }

    if (command === 'goodbye') {
        await m.reply(formatMessage('👋 GOODBYE', `Goodbye! Wishing you all the best.`, config.BOT_FOOTER));
        return;
    }

    if (command === 'server' || command === 'memory' || command === 'nodever') {
        const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
        await m.reply(formatMessage('🖥️ SYSTEM STATS', `• *Node:* ${process.version}\n• *Platform:* ${process.platform}\n• *Memory (RSS):* ${memMb} MB`, config.BOT_FOOTER));
        return;
    }

    if (command === 'time' || command === 'timenow' || command === 'colombo') {
        await m.reply(formatMessage('🕒 SRI LANKA TIME', moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss (Asia/Colombo)'), config.BOT_FOOTER));
        return;
    }

    if (command === 'date') {
        await m.reply(formatMessage('📅 DATE', moment().tz('Asia/Colombo').format('dddd, MMMM Do YYYY'), config.BOT_FOOTER));
        return;
    }

    if (command === 'year') {
        await m.reply(formatMessage('📆 YEAR', moment().tz('Asia/Colombo').format('YYYY'), config.BOT_FOOTER));
        return;
    }

    if (command === 'month') {
        await m.reply(formatMessage('🗓️ MONTH', moment().tz('Asia/Colombo').format('MMMM (MM)'), config.BOT_FOOTER));
        return;
    }

    if (command === 'day') {
        await m.reply(formatMessage('☀️ DAY', moment().tz('Asia/Colombo').format('dddd'), config.BOT_FOOTER));
        return;
    }

    if (command === 'tz') {
        const zone = argsText || 'Asia/Colombo';
        if (!moment.tz.zone(zone)) {
            await m.reply(formatMessage('⚠️ TIMEZONE', `Invalid timezone: *${zone}*. Try *Asia/Colombo* or *UTC*.`, config.BOT_FOOTER));
            return;
        }
        await m.reply(formatMessage('🌍 TIMEZONE', `${zone}: *${moment().tz(zone).format('YYYY-MM-DD HH:mm:ss')}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'utc') {
        await m.reply(formatMessage('🌐 UTC TIME', moment.utc().format('YYYY-MM-DD HH:mm:ss UTC'), config.BOT_FOOTER));
        return;
    }

    if (command === 'iso') {
        await m.reply(formatMessage('🕒 ISO TIMESTAMP', new Date().toISOString(), config.BOT_FOOTER));
        return;
    }

    if (command === 'epoch') {
        await m.reply(formatMessage('⏱️ UNIX EPOCH', String(Math.floor(Date.now() / 1000)), config.BOT_FOOTER));
        return;
    }

    // Math & Converters
    if (command === 'calc' || command === 'calculate') {
        const res = safeMathEval(argsText);
        await m.reply(formatMessage('🧮 CALCULATOR', res !== null ? `*${argsText}* = *${res}*` : `Example: *${p}calc* (12 + 8) * 3`, config.BOT_FOOTER));
        return;
    }

    if (command === 'add' && numArgs.length >= 2) {
        await m.reply(formatMessage('➕ ADD', `${numArgs[0]} + ${numArgs[1]} = *${numArgs[0] + numArgs[1]}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'sub' && numArgs.length >= 2) {
        await m.reply(formatMessage('➖ SUBTRACT', `${numArgs[0]} - ${numArgs[1]} = *${numArgs[0] - numArgs[1]}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'mul' && numArgs.length >= 2) {
        await m.reply(formatMessage('✖️ MULTIPLY', `${numArgs[0]} × ${numArgs[1]} = *${numArgs[0] * numArgs[1]}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'div' && numArgs.length >= 2) {
        if (numArgs[1] === 0) {
            await m.reply(formatMessage('⚠️ DIVIDE', 'Cannot divide by zero.', config.BOT_FOOTER));
            return;
        }
        await m.reply(formatMessage('➗ DIVIDE', `${numArgs[0]} ÷ ${numArgs[1]} = *${numArgs[0] / numArgs[1]}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'percent' && numArgs.length >= 2) {
        await m.reply(formatMessage('📊 PERCENTAGE', `${numArgs[0]}% of ${numArgs[1]} = *${(numArgs[0] / 100) * numArgs[1]}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'ctof' && numArgs.length >= 1) {
        const f = (numArgs[0] * 9) / 5 + 32;
        await m.reply(formatMessage('🌡️ CELSIUS TO FAHRENHEIT', `${numArgs[0]}°C = *${f.toFixed(2)}°F*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'ftoc' && numArgs.length >= 1) {
        const c = ((numArgs[0] - 32) * 5) / 9;
        await m.reply(formatMessage('🌡️ FAHRENHEIT TO CELSIUS', `${numArgs[0]}°F = *${c.toFixed(2)}°C*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'bmi' && numArgs.length >= 2) {
        const weight = numArgs[0];
        const heightM = numArgs[1] > 3 ? numArgs[1] / 100 : numArgs[1];
        const bmi = weight / (heightM * heightM);
        await m.reply(formatMessage('⚖️ BMI CALCULATOR', `BMI: *${bmi.toFixed(2)}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'tipcalc' && numArgs.length >= 2) {
        const tip = (numArgs[0] * numArgs[1]) / 100;
        await m.reply(formatMessage('💵 TIP CALCULATOR', `Tip (${numArgs[1]}%): *${tip.toFixed(2)}*\nTotal: *${(numArgs[0] + tip).toFixed(2)}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'discount' && numArgs.length >= 2) {
        const saved = (numArgs[0] * numArgs[1]) / 100;
        await m.reply(formatMessage('🏷️ DISCOUNT', `Discount (${numArgs[1]}%): *-${saved.toFixed(2)}*\nFinal Price: *${(numArgs[0] - saved).toFixed(2)}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'age' && numArgs.length >= 1) {
        const birthYear = numArgs[0];
        const currentYear = parseInt(moment().tz('Asia/Colombo').format('YYYY'), 10);
        if (birthYear > 1900 && birthYear <= currentYear) {
            await m.reply(formatMessage('🎂 APPROXIMATE AGE', `Born ${birthYear} → Approx *${currentYear - birthYear} years* old.`, config.BOT_FOOTER));
            return;
        }
    }

    // Text transforms
    const textStyles = ['upper', 'lower', 'reverse', 'spacing', 'dash', 'dot', 'slash', 'bubble', 'boldsans', 'italic'];
    if (textStyles.includes(command)) {
        if (!argsText) {
            await m.reply(formatMessage('✍️ TEXT TOOL', `Example: *${p}${command}* hello world`, config.BOT_FOOTER));
            return;
        }
        await m.reply(formatMessage(`✍️ ${command.toUpperCase()}`, transformTextStyle(argsText, command), config.BOT_FOOTER));
        return;
    }

    if (command === 'mono' && argsText) {
        await m.reply(formatMessage('💻 MONOSPACE', `\`\`\`${argsText}\`\`\``, config.BOT_FOOTER));
        return;
    }

    if (command === 'len' && argsText) {
        await m.reply(formatMessage('📏 CHARACTER LENGTH', `Length: *${argsText.length}* characters`, config.BOT_FOOTER));
        return;
    }

    if (command === 'wordcount' && argsText) {
        const words = argsText.trim().split(/\s+/).length;
        await m.reply(formatMessage('📝 WORD COUNT', `Words: *${words}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'trim' && argsText) {
        await m.reply(formatMessage('✂️ TRIMMED', argsText.trim().replace(/\s+/g, ' '), config.BOT_FOOTER));
        return;
    }

    if (command === 'slug' && argsText) {
        const slug = argsText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        await m.reply(formatMessage('🔗 SLUG', slug || argsText, config.BOT_FOOTER));
        return;
    }

    if ((command === 'titlecase' || command === 'capitalize') && argsText) {
        const titled = argsText.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
        await m.reply(formatMessage('🔠 TITLE CASE', titled, config.BOT_FOOTER));
        return;
    }

    // Encoding & Generators
    if (command === 'base64' && argsText) {
        await m.reply(formatMessage('🔐 BASE64', `\`\`\`${Buffer.from(argsText, 'utf8').toString('base64')}\`\`\``, config.BOT_FOOTER));
        return;
    }

    if (command === 'unbase64' && argsText) {
        await m.reply(formatMessage('🔓 DECODED BASE64', Buffer.from(argsText, 'base64').toString('utf8'), config.BOT_FOOTER));
        return;
    }

    if (command === 'hex' && argsText) {
        await m.reply(formatMessage('🔢 HEX', Buffer.from(argsText, 'utf8').toString('hex'), config.BOT_FOOTER));
        return;
    }

    if (command === 'unhex' && argsText) {
        await m.reply(formatMessage('🔢 FROM HEX', Buffer.from(argsText, 'hex').toString('utf8'), config.BOT_FOOTER));
        return;
    }

    if (command === 'binary' && argsText) {
        const bin = argsText.split('').map(ch => ch.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
        await m.reply(formatMessage('0️⃣1️⃣ BINARY', bin, config.BOT_FOOTER));
        return;
    }

    if (command === 'urlencode' && argsText) {
        await m.reply(formatMessage('🌐 URL ENCODE', encodeURIComponent(argsText), config.BOT_FOOTER));
        return;
    }

    if (command === 'urldecode' && argsText) {
        await m.reply(formatMessage('🌐 URL DECODE', decodeURIComponent(argsText), config.BOT_FOOTER));
        return;
    }

    if (command === 'md5' && argsText) {
        await m.reply(formatMessage('🔑 MD5', crypto.createHash('md5').update(argsText).digest('hex'), config.BOT_FOOTER));
        return;
    }

    if (command === 'sha256' && argsText) {
        await m.reply(formatMessage('🔑 SHA256', crypto.createHash('sha256').update(argsText).digest('hex'), config.BOT_FOOTER));
        return;
    }

    if (command === 'uuid') {
        await m.reply(formatMessage('🆔 UUID', crypto.randomUUID(), config.BOT_FOOTER));
        return;
    }

    if (command === 'password') {
        const len = Math.min(Math.max(numArgs[0] || 14, 8), 32);
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
        let pass = '';
        for (let i = 0; i < len; i++) {
            pass += chars[crypto.randomInt(0, chars.length)];
        }
        await m.reply(formatMessage('🔒 STRONG PASSWORD', `\`\`\`${pass}\`\`\``, config.BOT_FOOTER));
        return;
    }

    if (command === 'randomnum') {
        const min = numArgs[0] ?? 1;
        const max = numArgs[1] ?? 100;
        const val = crypto.randomInt(Math.min(min, max), Math.max(min, max) + 1);
        await m.reply(formatMessage('🎲 RANDOM NUMBER', `Range [${min} - ${max}] → *${val}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'coinflip') {
        await m.reply(formatMessage('🪙 COIN FLIP', Math.random() < 0.5 ? '*HEADS*' : '*TAILS*', config.BOT_FOOTER));
        return;
    }

    if (command === 'roll' || command === 'dice') {
        const sides = numArgs[0] && numArgs[0] >= 2 ? Math.min(numArgs[0], 100) : 6;
        await m.reply(formatMessage('🎲 DICE ROLL', `Rolled (1–${sides}): *${crypto.randomInt(1, sides + 1)}*`, config.BOT_FOOTER));
        return;
    }

    // AI Chat Commands
    const aiModes = {
        ai: 'normal',
        ai2: 'short',
        gpt: 'normal',
        gemini: 'normal',
        ask: 'normal',
        explain: 'explain',
        code: 'code',
        translate: 'translate',
        summary: 'short',
        grammar: 'short',
        idea: 'normal',
        poem: 'normal',
        story: 'normal',
        advisor: 'explain'
    };

    if (Object.prototype.hasOwnProperty.call(aiModes, command)) {
        if (!argsText) {
            await m.reply(formatMessage('🤖 AI CHAT', `Please enter a prompt.\nExample: *${p}${command}* What is Node.js?`, config.BOT_FOOTER));
            return;
        }
        await m.react('🤖');
        const reply = await fetchAiReply(argsText, aiModes[command]);
        if (!reply) {
            await m.reply(formatMessage('⚠️ AI ERROR', 'Unable to fetch AI response right now. Please try again later.', config.BOT_FOOTER));
            return;
        }
        await m.reply(formatMessage(`🤖 AI (${command.toUpperCase()})`, reply, config.BOT_FOOTER));
        return;
    }

    // Profile Picture
    if (command === 'getdp' || command === 'dp') {
        await m.react('🖼️');
        const targetJid = resolveTargetJid(m, argsText);
        try {
            const ppUrl = await socket.profilePictureUrl(targetJid, 'image');
            if (!ppUrl) {
                await m.reply(formatMessage('❌ DP NOT FOUND', `No profile picture found for ${targetJid}.`, config.BOT_FOOTER));
                return;
            }
            await socket.sendMessage(m.chat, {
                image: { url: ppUrl },
                caption: formatMessage('🖼️ PROFILE PICTURE', `👤 *Target:* ${targetJid}`, config.BOT_FOOTER)
            }, { quoted: m });
        } catch (_) {
            await m.reply(formatMessage('❌ DP NOT FOUND', `Unable to fetch profile picture for ${targetJid}.`, config.BOT_FOOTER));
        }
        return;
    }

    // Media Downloaders
    if (command === 'song' || command === 'audio' || command === 'play') {
        if (!argsText) {
            await m.reply(formatMessage('🎵 SONG', `Example: *${p}${command}* Shape of You`, config.BOT_FOOTER));
            return;
        }
        await m.react('🎵');
        const media = await fetchMediaByQuery(argsText, 'song');
        if (!media?.url) {
            await m.reply(formatMessage('⚠️ SONG ERROR', 'Could not download audio right now.', config.BOT_FOOTER));
            return;
        }
        await socket.sendMessage(m.chat, { audio: { url: media.url }, mimetype: 'audio/mpeg', ptt: false }, { quoted: m });
        return;
    }

    if (command === 'video' || command === 'mp4') {
        if (!argsText) {
            await m.reply(formatMessage('🎬 VIDEO', `Example: *${p}${command}* Nature 4K`, config.BOT_FOOTER));
            return;
        }
        await m.react('🎬');
        const media = await fetchMediaByQuery(argsText, 'video');
        if (!media?.url) {
            await m.reply(formatMessage('⚠️ VIDEO ERROR', 'Could not download video right now.', config.BOT_FOOTER));
            return;
        }
        await socket.sendMessage(m.chat, {
            video: { url: media.url },
            caption: formatMessage('🎬 VIDEO', `📌 *Title:* ${media.title}`, config.BOT_FOOTER)
        }, { quoted: m });
        return;
    }

    if (command === 'tt' || command === 'tiktok') {
        if (!argsText || !/tiktok\.com/i.test(argsText)) {
            await m.reply(formatMessage('📱 TIKTOK', `Example: *${p}${command}* https://vm.tiktok.com/...`, config.BOT_FOOTER));
            return;
        }
        await m.react('📱');
        const media = await fetchMediaByQuery(argsText, 'tt');
        if (!media?.url) {
            await m.reply(formatMessage('⚠️ TIKTOK ERROR', 'Could not download TikTok video.', config.BOT_FOOTER));
            return;
        }
        await socket.sendMessage(m.chat, {
            video: { url: media.url },
            caption: formatMessage('📱 TIKTOK', `📌 *Title:* ${media.title}`, config.BOT_FOOTER)
        }, { quoted: m });
        return;
    }

    if (command === 'fb' || command === 'facebook') {
        if (!argsText) {
            await m.reply(formatMessage('📘 FACEBOOK', `Example: *${p}${command}* <facebook video url>`, config.BOT_FOOTER));
            return;
        }
        await m.react('📘');
        const media = await fetchMediaByQuery(argsText, 'fb');
        if (!media?.url) {
            await m.reply(formatMessage('⚠️ FB ERROR', 'Could not download Facebook video.', config.BOT_FOOTER));
            return;
        }
        await socket.sendMessage(m.chat, {
            video: { url: media.url },
            caption: formatMessage('📘 FACEBOOK VIDEO', `📌 *Title:* ${media.title}`, config.BOT_FOOTER)
        }, { quoted: m });
        return;
    }

    if (command === 'insta' || command === 'instagram') {
        if (!argsText) {
            await m.reply(formatMessage('📸 INSTAGRAM', `Example: *${p}${command}* <instagram post/reel url>`, config.BOT_FOOTER));
            return;
        }
        await m.react('📸');
        const media = await fetchMediaByQuery(argsText, 'insta');
        if (!media?.url) {
            await m.reply(formatMessage('⚠️ INSTA ERROR', 'Could not download Instagram media.', config.BOT_FOOTER));
            return;
        }
        await socket.sendMessage(m.chat, {
            video: { url: media.url },
            caption: formatMessage('📸 INSTAGRAM MEDIA', `📌 *Title:* ${media.title}`, config.BOT_FOOTER)
        }, { quoted: m });
        return;
    }

    // Fun, Quotes & Facts
    const quotesList = [
        'Success is not final, failure is not fatal: it is the courage to continue that counts.',
        'Small daily improvements over time lead to stunning results.',
        'Discipline bridges the gap between goals and accomplishment.'
    ];
    const factsList = [
        'Octopuses have three hearts and blue blood.',
        'Honey never spoils when stored properly in a sealed container.',
        'Light from the Sun takes about 8 minutes and 20 seconds to reach Earth.'
    ];
    const jokesList = [
        'Why do programmers prefer dark mode? Because light attracts bugs!',
        'Why did the developer quit his job? Because he didn’t get arrays!'
    ];
    const riddlesList = [
        'What has keys that open no locks, space but no room, and you can enter but not go outside? → A Keyboard.',
        'The more you take, the more you leave behind. What am I? → Footsteps.'
    ];

    if (command === 'quote' || command === 'quotes' || command === 'motivation' || command === 'wisdom' || command === 'proverb') {
        const pick = quotesList[crypto.randomInt(0, quotesList.length)];
        await m.reply(formatMessage(`💬 ${command.toUpperCase()}`, `"${pick}"`, config.BOT_FOOTER));
        return;
    }

    if (command === 'fact' || command === 'facts' || command === 'mathfact' || command === 'trivia' || command === 'factcheck') {
        const pick = factsList[crypto.randomInt(0, factsList.length)];
        await m.reply(formatMessage(`🧠 ${command.toUpperCase()}`, pick, config.BOT_FOOTER));
        return;
    }

    if (command === 'joke' || command === 'jokes') {
        const pick = jokesList[crypto.randomInt(0, jokesList.length)];
        await m.reply(formatMessage('😂 JOKE', pick, config.BOT_FOOTER));
        return;
    }

    if (command === 'riddle') {
        const pick = riddlesList[crypto.randomInt(0, riddlesList.length)];
        await m.reply(formatMessage('🧩 RIDDLE', pick, config.BOT_FOOTER));
        return;
    }

    if (command === 'compliment') {
        await m.reply(formatMessage('🌟 COMPLIMENT', 'You have a great mind and bring positive energy wherever you go!', config.BOT_FOOTER));
        return;
    }

    if (command === '8ball') {
        const answers = ['Yes, definitely.', 'Ask again later.', 'Outlook looks good.', 'Better not tell you now.', 'Very likely.'];
        await m.reply(formatMessage('🎱 MAGIC 8-BALL', answers[crypto.randomInt(0, answers.length)], config.BOT_FOOTER));
        return;
    }

    if (command === 'rate') {
        const score = crypto.randomInt(1, 101);
        await m.reply(formatMessage('📊 RATE', `${argsText || 'This'} → *${score}/100*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'pick') {
        const items = argsText.split(/[,|]/).map(s => s.trim()).filter(Boolean);
        if (items.length < 2) {
            await m.reply(formatMessage('🎯 PICK', `Example: *${p}pick* Tea, Coffee, Juice`, config.BOT_FOOTER));
            return;
        }
        await m.reply(formatMessage('🎯 PICKED', `*${items[crypto.randomInt(0, items.length)]}*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'ship') {
        const pct = crypto.randomInt(1, 101);
        await m.reply(formatMessage('💞 COMPATIBILITY', `${argsText || 'Pair'} → *${pct}%*`, config.BOT_FOOTER));
        return;
    }

    // Study, Productivity & Chat Info
    if (['define', 'meaning', 'synonym', 'antonym', 'acronym', 'checklist', 'todo', 'note', 'remind', 'pomodoro', 'studyplan', 'flashcard', 'quiz', 'tip', 'techtip', 'lifehack', 'book', 'movieidea', 'traveltip', 'healthytip'].includes(command)) {
        if (!argsText) {
            await m.reply(formatMessage(`📌 ${command.toUpperCase()}`, `Example: *${p}${command}* <topic or text>`, config.BOT_FOOTER));
            return;
        }
        const aiOut = await fetchAiReply(`Provide a clear, concise response for ${command} regarding: ${argsText}`, 'short');
        await m.reply(formatMessage(`📌 ${command.toUpperCase()}`, aiOut || `Noted: ${argsText}`, config.BOT_FOOTER));
        return;
    }

    if (command === 'jid') {
        await m.reply(formatMessage('🆔 CHAT JID', `\`${m.chat}\``, config.BOT_FOOTER));
        return;
    }

    if (command === 'chatinfo' || command === 'groupinfo') {
        const isGroup = m.chat.endsWith('@g.us');
        await m.reply(formatMessage(
            'ℹ️ CHAT INFO',
            `• *Chat JID:* ${m.chat}\n• *Type:* ${isGroup ? 'Group Chat' : 'Direct / Private Chat'}\n• *Sender:* ${m.sender || 'Unknown'}`,
            config.BOT_FOOTER
        ));
        return;
    }

    if (command === 'admins' || command === 'members' || command === 'link') {
        if (!m.chat.endsWith('@g.us')) {
            await m.reply(formatMessage('👥 GROUP ONLY', `This command works inside WhatsApp groups.`, config.BOT_FOOTER));
            return;
        }
        try {
            const meta = await socket.groupMetadata(m.chat);
            if (command === 'admins') {
                const admins = meta.participants.filter(u => u.admin).map(u => `@${u.id.split('@')[0]}`);
                await socket.sendMessage(m.chat, {
                    text: formatMessage('🛡️ GROUP ADMINS', admins.join('\n') || 'None', config.BOT_FOOTER),
                    mentions: meta.participants.filter(u => u.admin).map(u => u.id)
                }, { quoted: m });
            } else if (command === 'members') {
                await m.reply(formatMessage('👥 MEMBERS COUNT', `Total members: *${meta.participants.length}*`, config.BOT_FOOTER));
            } else if (command === 'link') {
                const code = await socket.groupInviteCode(m.chat);
                await m.reply(formatMessage('🔗 GROUP LINK', `https://chat.whatsapp.com/${code}`, config.BOT_FOOTER));
            }
        } catch (_) {
            await m.reply(formatMessage('⚠️ GROUP ERROR', `Bot needs admin permission for this action.`, config.BOT_FOOTER));
        }
        return;
    }

    // 151 - 166: Additional Useful Commands
    if (command === 'ytsearch' || command === 'yts') {
        if (!argsText) {
            await m.reply(formatMessage('🔎 YOUTUBE SEARCH', `Example: *${p}${command}* Sinhala songs`, config.BOT_FOOTER));
            return;
        }
        await m.react('🔎');
        const aiRes = await fetchAiReply(`List 5 popular YouTube video titles/topics and search terms related to: ${argsText}`, 'short');
        await m.reply(formatMessage('🔎 YOUTUBE SEARCH', aiRes || `Search query: ${argsText}`, config.BOT_FOOTER));
        return;
    }

    if (command === 'img') {
        if (!argsText) {
            await m.reply(formatMessage('🖼️ IMAGE SEARCH', `Example: *${p}img* sunset beach`, config.BOT_FOOTER));
            return;
        }
        await m.react('🖼️');
        const encodedQuery = encodeURIComponent(argsText);
        const imgUrl = `https://image.pollinations.ai/prompt/${encodedQuery}`;
        await socket.sendMessage(m.chat, {
            image: { url: imgUrl },
            caption: formatMessage('🖼️ IMAGE RESULT', `📌 *Query:* ${argsText}`, config.BOT_FOOTER)
        }, { quoted: m });
        return;
    }

    if (command === 'qr') {
        if (!argsText) {
            await m.reply(formatMessage('📱 QR CODE', `Example: *${p}qr* https://example.com`, config.BOT_FOOTER));
            return;
        }
        await m.react('📱');
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(argsText)}`;
        await socket.sendMessage(m.chat, {
            image: { url: qrUrl },
            caption: formatMessage('📱 QR CODE GENERATED', `🔗 *Data:* ${argsText}`, config.BOT_FOOTER)
        }, { quoted: m });
        return;
    }

    if (command === 'shorten') {
        if (!argsText || !/^https?:\/\//i.test(argsText)) {
            await m.reply(formatMessage('🔗 URL SHORTENER', `Example: *${p}shorten* https://example.com/very/long/url`, config.BOT_FOOTER));
            return;
        }
        await m.react('🔗');
        try {
            const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(argsText)}`, { timeout: 15000 });
            const shortUrl = typeof res.data === 'string' && res.data.startsWith('http') ? res.data.trim() : null;
            await m.reply(formatMessage(
                '🔗 SHORTENED URL',
                shortUrl ? `✅ *Short Link:* ${shortUrl}` : `⚠️ Could not shorten URL right now.`,
                config.BOT_FOOTER
            ));
        } catch (_) {
            await m.reply(formatMessage('⚠️ SHORTENER ERROR', 'Failed to shorten URL.', config.BOT_FOOTER));
        }
        return;
    }

    if (command === 'weather') {
        if (!argsText) {
            await m.reply(formatMessage('⛅ WEATHER', `Example: *${p}weather* Colombo`, config.BOT_FOOTER));
            return;
        }
        await m.react('⛅');
        try {
            const res = await axios.get(`https://wttr.in/${encodeURIComponent(argsText)}?format=j1`, { timeout: 15000 });
            const current = res.data?.current_condition?.[0];
            const desc = current?.weatherDesc?.[0]?.value || 'N/A';
            const tempC = current?.temp_C ?? 'N/A';
            const humidity = current?.humidity ?? 'N/A';
            await m.reply(formatMessage(
                `⛅ WEATHER — ${argsText.toUpperCase()}`,
                `• *Condition:* ${desc}\n• *Temperature:* ${tempC}°C\n• *Humidity:* ${humidity}%`,
                config.BOT_FOOTER
            ));
        } catch (_) {
            await m.reply(formatMessage('⚠️ WEATHER ERROR', `Could not fetch weather for *${argsText}*.`, config.BOT_FOOTER));
        }
        return;
    }

    if (command === 'translate_si') {
        if (!argsText) {
            await m.reply(formatMessage('🌐 TRANSLATE TO SINHALA', `Example: *${p}translate_si* Good morning`, config.BOT_FOOTER));
            return;
        }
        await m.react('🌐');
        const out = await fetchAiReply(`Translate the following text accurately into natural Sinhala:\n${argsText}`, 'short');
        await m.reply(formatMessage('🌐 SINHALA TRANSLATION', out || argsText, config.BOT_FOOTER));
        return;
    }

    if (command === 'translate_en') {
        if (!argsText) {
            await m.reply(formatMessage('🌐 TRANSLATE TO ENGLISH', `Example: *${p}translate_en* සුබ උදෑසනක්`, config.BOT_FOOTER));
            return;
        }
        await m.react('🌐');
        const out = await fetchAiReply(`Translate the following text accurately into natural English:\n${argsText}`, 'short');
        await m.reply(formatMessage('🌐 ENGLISH TRANSLATION', out || argsText, config.BOT_FOOTER));
        return;
    }

    if (command === 'sinhala') {
        if (!argsText) {
            await m.reply(formatMessage('🇱🇰 SINHALA AI', `උදාහරණය: *${p}sinhala* කාලගුණ වෙනස්වීම ගැන කෙටියෙන් කියන්න`, config.BOT_FOOTER));
            return;
        }
        await m.react('🇱🇰');
        const out = await fetchAiReply(`Answer clearly in Sinhala:\n${argsText}`, 'normal');
        await m.reply(formatMessage('🇱🇰 SINHALA AI', out || 'මේ මොහොතේ පිළිතුරක් ලබාගත නොහැක.', config.BOT_FOOTER));
        return;
    }

    if (command === 'codefix') {
        if (!argsText) {
            await m.reply(formatMessage('🛠️ CODE FIXER', `Example: *${p}codefix* TypeError: Cannot read properties of undefined`, config.BOT_FOOTER));
            return;
        }
        await m.react('🛠️');
        const out = await fetchAiReply(`Identify the bug/error and provide a clean fix with brief explanation:\n${argsText}`, 'code');
        await m.reply(formatMessage('🛠️ CODE FIX', out || 'Unable to analyze code right now.', config.BOT_FOOTER));
        return;
    }

    if (command === 'notes_help') {
        await m.reply(formatMessage(
            '📝 NOTES & STUDY GUIDE',
            `• *${p}note <text>* — Save/format a note\n• *${p}todo <task>* — Add a to-do item\n• *${p}checklist <items>* — Create a checklist\n• *${p}studyplan <subject>* — Get a quick study plan`,
            config.BOT_FOOTER
        ));
        return;
    }

    if (command === 'botping') {
        const t0 = Date.now();
        await m.react('⚡');
        await m.reply(formatMessage('⚡ BOT PING', `Response time: *${Date.now() - t0}ms*`, config.BOT_FOOTER));
        return;
    }

    if (command === 'bio') {
        await m.reply(formatMessage(
            `🤖 ${config.BOT_NAME} BIO`,
            `Multi-device WhatsApp assistant built with Baileys & Node.js.\n• *Prefix:* ${p}\n• *Commands:* ${SAFE_COMMANDS.length}`,
            config.BOT_FOOTER
        ));
        return;
    }

    if (command === 'support') {
        await m.reply(formatMessage(
            '🛟 SUPPORT & COMMUNITY',
            `• *Owner:* ${config.OWNER_NUMBER}\n• *Group:* ${config.GROUP_INVITE_LINK || 'Not configured'}`,
            config.BOT_FOOTER
        ));
        return;
    }

    if (command === 'clear_cache') {
        otpStore.clear();
        const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
        await m.reply(formatMessage('🧹 CACHE CLEARED', `Expired/temporary OTP cache cleared.\n• *Current Memory:* ${memMb} MB`, config.BOT_FOOTER));
        return;
    }

    if (command === 'allcmds') {
        await m.reply(formatMessage(
            '📚 ALL COMMANDS SUMMARY',
            `Total registered safe commands: *${SAFE_COMMANDS.length}*\nUse *${p}menu* to view the full list.`,
            config.BOT_FOOTER
        ));
    }
}

function setupCommandListener(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' || !messages || !messages[0]) return;
        try {
            const m = sms(socket, messages[0]);
            if (!m || !m.message) return;

            const body = (m.body || '').trim();
            if (!body.startsWith(config.PREFIX)) return;

            const withoutPrefix = body.slice(config.PREFIX.length).trim();
            const parts = withoutPrefix.split(/\s+/);
            const command = (parts[0] || '').toLowerCase();
            const argsText = withoutPrefix.slice(parts[0]?.length || 0).trim();

            if (!SAFE_COMMANDS.includes(command)) return;

            await handleSafeCommand(socket, number, m, command, argsText);
        } catch (err) {
            console.error('Command listener error:', err);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
};

async function deleteSessionFromFirebase(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const firebaseSessionPath = `session/creds_${sanitizedNumber}.json`;
        const { data } = await axios.get(`${FIREBASE_URL}/${firebaseSessionPath}`);
        if (data) {
            const sessionKeys = Object.keys(data).filter(key =>
                key.includes(sanitizedNumber) && key.endsWith('.json')
            );
            for (const key of sessionKeys) {
                await axios.delete(`${FIREBASE_URL}/session/${key.replace('.json', '')}.json`);
                console.log(`Deleted Firebase session file: ${key}`);
            }
        }
        let numbers = [];
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        if (numbersRes.data) {
            numbers = numbersRes.data.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
        }
    } catch (error) {
        console.error('Failed to delete session from Firebase:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const credsKey = `creds_${sanitizedNumber}`;
        const { data } = await axios.get(`${FIREBASE_URL}/session/${credsKey}.json`);
        return data || null;
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configKey = `config_${sanitizedNumber}`;
        const { data } = await axios.get(`${FIREBASE_URL}/session/${configKey}.json`);
        return data || { ...config };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configKey = `config_${sanitizedNumber}`;
        await axios.put(`${FIREBASE_URL}/session/${configKey}.json`, newConfig);
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

async function deleteFirebaseSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const sessionPath = `session/session_${sanitizedNumber}.json`;
        await axios.delete(`${FIREBASE_URL}/${sessionPath}`);
        console.log(`Deleted Firebase session for ${sanitizedNumber}`);
    } catch (err) {
        console.error(`Failed to delete Firebase session for ${number}:`, err.message || err);
    }
}

async function fullDeleteSession(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
            console.log(`🗑️ Deleted local session folder for ${sanitizedNumber}`);
        }

        const pathsToDelete = [
            `session/creds_${sanitizedNumber}`,
            `numbers/${sanitizedNumber}`,
            `session/config_${sanitizedNumber}`
        ];
        for (const p of pathsToDelete) {
            try {
                await axios.delete(`${FIREBASE_URL}/${p}.json`);
                console.log(`🗑️ Deleted Firebase path: ${p}`);
            } catch (e) {
                console.warn(`⚠️ Firebase delete failed for ${p}:`, e.message);
            }
        }

        try {
            const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
            let numbers = numbersRes.data || [];
            if (!Array.isArray(numbers)) numbers = [];
            numbers = numbers.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
            console.log(`✅ Removed ${sanitizedNumber} from numbers.json`);
        } catch (e) {
            console.warn(`⚠️ Failed updating numbers.json:`, e.message);
        }

        if (activeSockets.has(sanitizedNumber)) {
            try {
                activeSockets.get(sanitizedNumber).ws.close();
            } catch (e) {
                console.warn(`⚠️ Socket close error for ${sanitizedNumber}:`, e.message);
            }
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
            console.log(`✅ Socket removed for ${sanitizedNumber}`);
        }
    } catch (err) {
        console.error(`❌ Failed to fully delete session for ${sanitizedNumber}:`, err.message);
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const cleanNumber = number.replace(/[^0-9]/g, '');

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (statusCode === 401) {
                console.log(`User ${number} logged out. Deleting session...`);

                await fullDeleteSession(number);

                const sessionPath = path.join(SESSION_BASE_PATH, `session_${cleanNumber}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                    console.log(`Deleted local session folder for ${number}`);
                }

                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);

                try {
                    const caption = formatMessage(
                        '🗑️ SESSION DELETED',
                        '✅ Your session has been deleted due to logout.',
                        config.BOT_FOOTER
                    );
                    const imagePayload = getImagePayload(config.RCD_IMAGE_PATH);
                    if (imagePayload) {
                        await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                            image: imagePayload,
                            caption
                        });
                    } else {
                        await socket.sendMessage(jidNormalizedUser(socket.user.id), { text: caption });
                    }
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error.message || error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);

                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupAutoRestart(socket, sanitizedNumber);
        handleMessageRevocation(socket, sanitizedNumber);
        setupCommandListener(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            await axios.put(`${FIREBASE_URL}/session/creds_${sanitizedNumber}.json`, JSON.parse(fileContent));
            console.log(`Updated creds for ${sanitizedNumber} in Firebase`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    await joinGroupFromConfig(socket, config.GROUP_INVITE_LINK);

                    const caption = formatMessage(
                        config.BOT_NAME,
                        `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n`,
                        config.BOT_FOOTER
                    );
                    const imagePayload = getImagePayload(config.RCD_IMAGE_PATH);
                    if (imagePayload) {
                        await socket.sendMessage(userJid, {
                            image: imagePayload,
                            caption
                        });
                    } else {
                        await socket.sendMessage(userJid, { text: caption });
                    }

                    let numbers = [];
                    const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
                    if (numbersRes.data) {
                        numbers = numbersRes.data;
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'SHAWIN-MINI-main'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '👻 LOS-KING-XMD is running',
        activesession: activeSockets.size
    });
});

router.get('/botinfo', async (req, res) => {
    try {
        const bots = Array.from(activeSockets.entries()).map(([number, socket]) => {
            const startTime = socketCreationTime.get(number) || Date.now();
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = Math.floor(uptime % 60);

            return {
                number: number,
                status: socket.ws && socket.ws.readyState === 1 ? 'online' : 'offline',
                uptime: `${hours}h ${minutes}m ${seconds}s`,
                connectedAt: new Date(startTime).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }),
            };
        });

        res.json({
            count: bots.length,
            bots
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get bot info', details: err.message });
    }
});

router.get('/connect-all', async (req, res) => {
    try {
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        const sessionKeys = Object.keys(data || {}).filter(key =>
            key.startsWith('creds_') && key.endsWith('.json')
        );

        if (sessionKeys.length === 0) {
            return res.status(404).send({ error: 'No session files found in Firebase' });
        }

        const results = [];
        for (const key of sessionKeys) {
            const match = key.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${key}`);
                results.push({ file: key, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            const caption = formatMessage(
                '📌 CONFIG UPDATED',
                'Your configuration has been successfully updated!',
                config.BOT_FOOTER
            );
            const imagePayload = getImagePayload(config.RCD_IMAGE_PATH);
            if (imagePayload) {
                await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                    image: imagePayload,
                    caption
                });
            } else {
                await socket.sendMessage(jidNormalizedUser(socket.user.id), { text: caption });
            }
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'SHAWIN-MINI-main'}`);
});

async function autoReconnectFromFirebase() {
    try {
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from Firebase: ${number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromFirebase error:', error.message);
    }
}
autoReconnectFromFirebase();

module.exports = router;

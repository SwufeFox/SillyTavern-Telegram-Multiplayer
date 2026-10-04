// server.js
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Telegram 消息长度限制
const TELEGRAM_MAX_LENGTH = 4096;

/**
 * 将长消息分割成多个部分，确保每部分不超过 Telegram 限制
 * @param {string} text - 原始文本
 * @param {number} maxLength - 最大长度，默认 4096
 * @returns {string[]} - 分割后的消息数组
 */
function splitLongMessage(text, maxLength = TELEGRAM_MAX_LENGTH) {
    if (!text || text.length <= maxLength) {
        return [text];
    }

    const parts = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            parts.push(remaining);
            break;
        }

        // 尝试在换行符处分割
        let splitIndex = remaining.lastIndexOf('\n', maxLength);

        // 如果没有找到换行符，尝试在空格处分割
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
            splitIndex = remaining.lastIndexOf(' ', maxLength);
        }

        // 如果还是没找到，强制在 maxLength 处分割
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
            splitIndex = maxLength;
        }

        parts.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trimStart();
    }

    // 添加分页标记
    if (parts.length > 1) {
        parts.forEach((part, index) => {
            parts[index] = `📄 [${index + 1}/${parts.length}]\n\n${part}`;
        });
    }

    return parts;
}


// Upload/import state. Files are handled only after user enters upload mode.
const UPLOAD_DIR = process.env.BRIDGE_UPLOAD_DIR || path.join(os.tmpdir(), 'st-bridge-uploads');
const UPLOAD_TTL_MS = Number(process.env.BRIDGE_UPLOAD_TTL_MS || 5 * 60 * 1000);
const MAX_CHARACTER_UPLOAD_BYTES = Number(process.env.BRIDGE_MAX_CHARACTER_UPLOAD_BYTES || 20 * 1024 * 1024);
const MAX_PRESET_UPLOAD_BYTES = Number(process.env.BRIDGE_MAX_PRESET_UPLOAD_BYTES || 2 * 1024 * 1024);
const uploadSessions = new Map();
const pendingUploads = new Map();

function ensureUploadDir() {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
}

function cleanupUploadFile(filePath) {
    if (!filePath) return;
    fs.unlink(filePath, () => {});
}

function getUploadSessionKey(chatId, userId) {
    return `${chatId}:${userId}`;
}

function clearUploadSession(chatId, userId, deleteFile = false) {
    const key = getUploadSessionKey(chatId, userId);
    const session = uploadSessions.get(key);
    if (deleteFile && session?.localPath) cleanupUploadFile(session.localPath);
    uploadSessions.delete(key);
}

function setUploadSession(chatId, userId, mode) {
    ensureUploadDir();
    clearUploadSession(chatId, userId, true);
    const session = { chatId, userId, mode, key: getUploadSessionKey(chatId, userId), createdAt: Date.now(), expiresAt: Date.now() + UPLOAD_TTL_MS };
    uploadSessions.set(session.key, session);
    setTimeout(() => {
        const current = uploadSessions.get(session.key);
        if (current && current.createdAt === session.createdAt && !current.fileId) {
            uploadSessions.delete(session.key);
        }
    }, UPLOAD_TTL_MS + 1000);
    return session;
}

function getActiveUploadSession(chatId, userId) {
    const key = getUploadSessionKey(chatId, userId);
    const session = uploadSessions.get(key);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
        clearUploadSession(chatId, userId, true);
        return null;
    }
    return session;
}

function sanitizeUploadFileName(fileName) {
    const base = path.basename(String(fileName || 'upload.bin')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
    return base || 'upload.bin';
}

function detectUploadKind(fileName, buffer, requestedMode) {
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const result = { ok: false, ext, kind: 'unknown', label: '未知文件', error: '', name: path.basename(fileName, path.extname(fileName)) };
    if (!['png', 'json'].includes(ext)) {
        result.error = '仅支持 .png / .json';
        return result;
    }
    if (['png'].includes(ext)) {
        if (requestedMode === 'preset') {
            result.error = '预设文件仅支持 JSON';
            return result;
        }
        result.ok = true;
        result.kind = 'character';
        result.label = `${ext.toUpperCase()} 角色卡`;
        return result;
    }
    let json = null;
    try {
        json = JSON.parse(buffer.toString('utf8'));
    } catch (error) {
        result.error = 'JSON 解析失败';
        return result;
    }
    const characterHints = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
    const cardV2Hints = json && typeof json === 'object' && json.data && typeof json.data === 'object'
        ? ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'].some(k => json.data[k])
        : false;
    const looksCharacter = json && typeof json === 'object' && (characterHints.some(k => json[k]) || cardV2Hints || json.spec === 'chara_card_v2');
    const looksPreset = json && typeof json === 'object' && !Array.isArray(json) && (
        Object.prototype.hasOwnProperty.call(json, 'temperature')
        || Object.prototype.hasOwnProperty.call(json, 'top_p')
        || Object.prototype.hasOwnProperty.call(json, 'max_context_unlocked')
        || Object.prototype.hasOwnProperty.call(json, 'prompts')
        || Object.prototype.hasOwnProperty.call(json, 'prompt_order')
        || Object.prototype.hasOwnProperty.call(json, 'chat_completion_source')
    );
    if (requestedMode === 'character') {
        if (!looksCharacter) {
            result.error = 'JSON 不像角色卡；如需导入预设，请选择“预设文件”或“自动识别”。';
            return result;
        }
        result.ok = true; result.kind = 'character'; result.label = 'JSON 角色卡'; return result;
    }
    if (requestedMode === 'preset') {
        if (!looksPreset) {
            result.error = 'JSON 不像 OpenAI/Chat Completion 预设；如确认是预设，请用自动识别后手动选择。';
            return result;
        }
        result.ok = true; result.kind = 'preset_openai'; result.label = 'OpenAI/Chat Completion 预设'; return result;
    }
    if (looksCharacter && !looksPreset) {
        result.ok = true; result.kind = 'character'; result.label = 'JSON 角色卡'; return result;
    }
    if (looksPreset && !looksCharacter) {
        result.ok = true; result.kind = 'preset_openai'; result.label = 'OpenAI/Chat Completion 预设'; return result;
    }
    if (looksCharacter && looksPreset) {
        result.ok = true; result.kind = 'ambiguous'; result.label = 'JSON 可能是角色卡或预设'; return result;
    }
    result.error = '无法识别 JSON 类型';
    return result;
}

function makeUploadId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getUploadMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '👤 角色卡', callback_data: 'cmd_upload_character' }, { text: '🎛️ 预设文件', callback_data: 'cmd_upload_preset' }],
            [{ text: '🔍 自动识别', callback_data: 'cmd_upload_auto' }, { text: '取消', callback_data: 'cmd_upload_cancel' }],
        ],
    };
}

async function handleUploadDocument(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const session = getActiveUploadSession(chatId, userId);
    if (!session) return false;

    const file = msg.document || (msg.photo && msg.photo[msg.photo.length - 1]);
    if (!file) return false;

    const originalName = sanitizeUploadFileName(msg.document?.file_name || `photo_${file.file_unique_id || file.file_id}.jpg`);
    const ext = path.extname(originalName).slice(1).toLowerCase();
    if (!msg.document) {
        await bot.sendMessage(chatId, '请以“文件/Document”方式上传角色卡，不要以压缩图片方式发送。');
        return true;
    }

    const limit = session.mode === 'preset' ? MAX_PRESET_UPLOAD_BYTES : MAX_CHARACTER_UPLOAD_BYTES;
    if (file.file_size && file.file_size > limit) {
        await bot.sendMessage(chatId, `文件过大：${(file.file_size / 1024 / 1024).toFixed(2)} MB，当前模式上限 ${(limit / 1024 / 1024).toFixed(0)} MB。`);
        return true;
    }
    if (!['png', 'json'].includes(ext)) {
        await bot.sendMessage(chatId, '文件类型不支持。角色卡支持 PNG/JSON；预设支持 JSON。');
        return true;
    }

    try {
        ensureUploadDir();
        const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${originalName}`;
        const localPath = path.join(UPLOAD_DIR, safeName);
        await bot.downloadFile(file.file_id, UPLOAD_DIR).then(downloadedPath => fs.promises.rename(downloadedPath, localPath));
        const stat = await fs.promises.stat(localPath);
        if (stat.size > limit) {
            cleanupUploadFile(localPath);
            await bot.sendMessage(chatId, `文件过大：${(stat.size / 1024 / 1024).toFixed(2)} MB，当前模式上限 ${(limit / 1024 / 1024).toFixed(0)} MB。`);
            return true;
        }
        const buffer = await fs.promises.readFile(localPath);
        const detected = detectUploadKind(originalName, buffer, session.mode);
        if (!detected.ok) {
            cleanupUploadFile(localPath);
            await bot.sendMessage(chatId, `检测失败：${detected.error}`);
            return true;
        }
        if (session.fileId) {
            const previous = pendingUploads.get(session.fileId);
            if (previous) {
                pendingUploads.delete(session.fileId);
                cleanupUploadFile(previous.localPath);
            }
        }

        const uploadId = makeUploadId();
        const pending = {
            id: uploadId,
            chatId,
            userId,
            mode: session.mode,
            localPath,
            fileName: originalName,
            size: stat.size,
            detected,
            expiresAt: Date.now() + UPLOAD_TTL_MS,
        };
        pendingUploads.set(uploadId, pending);
        session.fileId = uploadId;
        session.localPath = localPath;
        setTimeout(() => {
            const item = pendingUploads.get(uploadId);
            if (item && Date.now() > item.expiresAt) {
                pendingUploads.delete(uploadId);
                cleanupUploadFile(item.localPath);
                const currentSession = uploadSessions.get(item.key);
                if (currentSession?.fileId === uploadId) {
                    uploadSessions.delete(item.key);
                }
            }
        }, UPLOAD_TTL_MS + 1000);

        const keyboard = [];
        if (detected.kind === 'ambiguous') {
            keyboard.push([{ text: '作为角色卡导入', callback_data: `cmd_upload_import_char_${uploadId}` }]);
            keyboard.push([{ text: '作为 OpenAI 预设导入', callback_data: `cmd_upload_import_preset_${uploadId}` }]);
        } else if (detected.kind === 'character') {
            keyboard.push([{ text: '导入角色卡', callback_data: `cmd_upload_import_char_${uploadId}` }]);
            keyboard.push([{ text: '导入并切换', callback_data: `cmd_upload_import_switch_${uploadId}` }]);
        } else if (detected.kind === 'preset_openai') {
            keyboard.push([{ text: '导入 OpenAI 预设', callback_data: `cmd_upload_import_preset_${uploadId}` }]);
            keyboard.push([{ text: '导入并切换预设', callback_data: `cmd_upload_import_preset_switch_${uploadId}` }]);
        }
        keyboard.push([{ text: '取消', callback_data: `cmd_upload_cancel_${uploadId}` }]);
        await bot.sendMessage(chatId,
            `检测到文件：${originalName}\n类型：${detected.label}\n大小：${(stat.size / 1024 / 1024).toFixed(2)} MB\n\n请选择操作：`,
            { reply_markup: { inline_keyboard: keyboard } });
        return true;
    } catch (error) {
        logWithTimestamp('error', `处理上传文件失败: ${error.message}`);
        await bot.sendMessage(chatId, `处理上传文件失败：${error.message}`);
        return true;
    }
}

// 存储长消息的缓存，用于分页显示
const longMessageCache = new Map();

/**
 * 发送消息到 Telegram，超长消息使用分页按钮
 * @param {TelegramBot} bot - Telegram Bot 实例
 * @param {number} chatId - 聊天 ID
 * @param {string} text - 消息文本
 * @param {object} options - 发送选项
 */
async function sendLongMessage(bot, chatId, text, options = {}) {
    // 如果消息不超长，直接发送
    if (!text || text.length <= 4000) {
        try {
            await bot.sendMessage(chatId, text || '(空消息)', options);
        } catch (err) {
            logWithTimestamp('error', '发送消息失败:', err.message);
            // 如果格式化失败，尝试纯文本
            if (options.parse_mode) {
                await bot.sendMessage(chatId, text || '(空消息)').catch(() => {});
            }
        }
        return;
    }

    // 超长消息：分页处理
    const PAGE_SIZE = 3500; // 每页字符数
    const parts = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= PAGE_SIZE) {
            parts.push(remaining);
            break;
        }
        // 尝试在换行符处分割
        let splitIndex = remaining.lastIndexOf('\n', PAGE_SIZE);
        if (splitIndex === -1 || splitIndex < PAGE_SIZE * 0.5) {
            splitIndex = remaining.lastIndexOf(' ', PAGE_SIZE);
        }
        if (splitIndex === -1 || splitIndex < PAGE_SIZE * 0.5) {
            splitIndex = PAGE_SIZE;
        }
        parts.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trimStart();
    }

    // 生成唯一的缓存ID
    const cacheId = `msg_${chatId}_${Date.now()}`;
    longMessageCache.set(cacheId, { parts, chatId });

    // 5分钟后自动清理缓存
    setTimeout(() => longMessageCache.delete(cacheId), 5 * 60 * 1000);

    // 发送第一页
    await sendPagedMessage(bot, chatId, cacheId, 1, options);
}

/**
 * 发送分页消息
 */
async function sendPagedMessage(bot, chatId, cacheId, page, options = {}) {
    const cache = longMessageCache.get(cacheId);
    if (!cache) {
        await bot.sendMessage(chatId, '消息已过期，请重新请求');
        return;
    }

    const { parts } = cache;
    const totalPages = parts.length;
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const content = parts[currentPage - 1];

    // 构建分页按钮
    const buttons = [];
    if (currentPage > 1) {
        buttons.push({ text: `⬅️ ${currentPage - 1}/${totalPages}`, callback_data: `page_${cacheId}_${currentPage - 1}` });
    }
    if (currentPage < totalPages) {
        buttons.push({ text: `${currentPage + 1}/${totalPages} ➡️`, callback_data: `page_${cacheId}_${currentPage + 1}` });
    }

    const sendOptions = { ...options };
    if (buttons.length > 0) {
        sendOptions.reply_markup = { inline_keyboard: [buttons] };
    }

    const pageText = totalPages > 1 ? `📄 [${currentPage}/${totalPages}]\n\n${content}` : content;

    try {
        await bot.sendMessage(chatId, pageText, sendOptions);
    } catch (err) {
        logWithTimestamp('error', '发送分页消息失败:', err.message);
        // 回退到纯文本
        await bot.sendMessage(chatId, pageText).catch(() => {});
    }
}

// 添加日志记录函数，带有时间戳
function logWithTimestamp(level, ...args) {
    const now = new Date();

    // 使用本地时区格式化时间
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    const prefix = `[${timestamp}]`;

    switch (level) {
        case 'error':
            console.error(prefix, ...args);
            break;
        case 'warn':
            console.warn(prefix, ...args);
            break;
        default:
            console.log(prefix, ...args);
    }
}

// 重启保护 - 防止循环重启
const RESTART_PROTECTION_FILE = path.join(__dirname, '.restart_protection');
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000; // 1分钟

// 检查是否可能处于循环重启状态
function checkRestartProtection() {
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            const data = JSON.parse(fs.readFileSync(RESTART_PROTECTION_FILE, 'utf8'));
            const now = Date.now();

            // 清理过期的重启记录
            data.restarts = data.restarts.filter(time => now - time < RESTART_WINDOW_MS);

            // 添加当前重启时间
            data.restarts.push(now);

            // 如果在时间窗口内重启次数过多，则退出
            if (data.restarts.length > MAX_RESTARTS) {
                logWithTimestamp('error', `检测到可能的循环重启！在${RESTART_WINDOW_MS / 1000}秒内重启了${data.restarts.length}次。`);
                logWithTimestamp('error', '为防止资源耗尽，服务器将退出。请手动检查并修复问题后再启动。');

                // 如果有通知chatId，尝试发送错误消息
                if (process.env.RESTART_NOTIFY_CHATID) {
                    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
                    if (!isNaN(chatId)) {
                        // 创建临时bot发送错误消息
                        try {
                            const tempBot = new TelegramBot(require('./config').telegramToken, { polling: false });
                            tempBot.sendMessage(chatId, '检测到循环重启！服务器已停止以防止资源耗尽。请手动检查问题。')
                                .finally(() => process.exit(1));
                        } catch (e) {
                            process.exit(1);
                        }
                        return; // 等待消息发送后退出
                    }
                }

                process.exit(1);
            }

            // 保存更新后的重启记录
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify(data));
        } else {
            // 创建新的重启保护文件
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify({ restarts: [Date.now()] }));
        }
    } catch (error) {
        logWithTimestamp('error', '重启保护检查失败:', error);
        // 出错时继续执行，不要阻止服务器启动
    }
}

// 启动时检查重启保护
checkRestartProtection();

// --- 配置加载 ---
// 支持环境变量配置 (Docker) 和配置文件配置

// 检查配置文件是否存在
const configPath = path.join(__dirname, './config.js');
const exampleConfigPath = path.join(__dirname, './config.example.js');
let config = {};
let configSourceName = 'config.js';

// 测试模式：禁用 Telegram polling，避免测试容器抢占生产 Bot updates
const telegramDisabled = ['1', 'true', 'yes'].includes(String(process.env.BRIDGE_TELEGRAM_DISABLED || process.env.TELEGRAM_DISABLED || '').toLowerCase());

// 如果配置文件存在，加载它作为基础配置
if (fs.existsSync(configPath)) {
    config = require('./config');
} else if (fs.existsSync(exampleConfigPath)) {

    // 开发模式：没有 config.js 时自动回退到 config.example.js

    config = require('./config.example.js');

    configSourceName = 'config.example.js（开发模式，未找到 config.js）';

    logWithTimestamp('warn', '未找到 config.js，已自动回退到 config.example.js（开发模式）');

    logWithTimestamp('warn', '如需持久化配置，请复制 config.example.js 为 config.js 后修改');

} else if (!telegramDisabled && !process.env.TELEGRAM_BOT_TOKEN) {
    // 如果既没有配置文件也没有环境变量，则报错
    logWithTimestamp('error', '错误: 找不到配置文件 config.js 且未设置 TELEGRAM_BOT_TOKEN 环境变量！');
    logWithTimestamp('error', '请在server目录下复制 config.example.js 为 config.js，或设置 TELEGRAM_BOT_TOKEN 环境变量');
    process.exit(1); // 终止程序
}

// 环境变量优先级高于配置文件 (Requirements 2.3, 2.4)
// 读取 TELEGRAM_BOT_TOKEN 环境变量（let：开发模式下可能通过控制台输入覆盖）

let token = process.env.TELEGRAM_BOT_TOKEN || config.telegramToken || (telegramDisabled ? '0:disabled' : undefined);

// 读取 WSS_PORT 环境变量
const wssPort = parseInt(process.env.WSS_PORT) || config.wssPort || 2333;

// 读取 ALLOWED_USER_IDS 环境变量 (逗号分隔的用户ID列表)
if (process.env.ALLOWED_USER_IDS) {
    const envUserIds = process.env.ALLOWED_USER_IDS
        .split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id));
    if (envUserIds.length > 0) {
        config.allowedUserIds = envUserIds;
    }
}

// 读取 ALLOWED_CHAT_IDS 环境变量 (逗号分隔的聊天/群组ID列表)
// 群组场景下用于限制机器人只在指定群组/私聊中响应
if (process.env.ALLOWED_CHAT_IDS) {
    const envChatIds = process.env.ALLOWED_CHAT_IDS
        .split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id));
    if (envChatIds.length > 0) {
        config.allowedChatIds = envChatIds;
    }
}

// 读取 MESSAGE_PARSE_MODE 环境变量
if (process.env.MESSAGE_PARSE_MODE) {
    const parseMode = process.env.MESSAGE_PARSE_MODE.trim();
    config.messageFormat = config.messageFormat || {};
    if (parseMode === 'HTML' || parseMode === 'MarkdownV2') {
        config.messageFormat.parseMode = parseMode;
    } else if (parseMode === 'plain' || parseMode === '') {
        config.messageFormat.parseMode = null;
    }
}

// 检查是否修改了默认token
function isPlaceholderToken(t) {

    return !t || t === 'TOKEN' || t === 'YOUR_TELEGRAM_BOT_TOKEN_HERE';

}



/**

 * 从控制台同步读取一行输入（开发模式手动输入 Token 用）

 * @param {string} promptText - 提示文字

 * @returns {string} 用户输入的内容（已去除首尾空白）

 */

function readLineSync(promptText) {

    if (promptText) process.stdout.write(promptText);

    let line = '';

    const buf = Buffer.alloc(1);

    try {

        while (true) {

            const bytesRead = fs.readSync(process.stdin.fd, buf, 0, 1, null);

            if (bytesRead <= 0) break;

            const ch = buf.toString('utf8');

            // Windows 控制台回车是 \r\n，两者都视为行结束

            if (ch === '\n' || ch === '\r') break;

            line += ch;

        }

    } catch (error) {

        return '';

    }

    return line.trim();

}



// 如果 token 无效（占位符/为空）且未禁用 Telegram：

// - 交互式终端（开发模式）→ 在控制台手动输入 token（仅本次运行有效）

// - 非交互环境（Docker/后台）→ 保持原来的报错退出行为

if (!telegramDisabled && isPlaceholderToken(token)) {

    if (process.stdin.isTTY) {

        logWithTimestamp('warn', '未检测到有效的 Telegram Bot Token。');

        logWithTimestamp('warn', '开发模式：请在下方手动输入 Token（输入后按回车）：');

        const inputToken = readLineSync('> ');

        if (inputToken) {

            token = inputToken;

            logWithTimestamp('log', '已通过控制台输入 Token（仅本次运行有效，不会写入配置文件）。');

        } else {

            logWithTimestamp('error', '错误: 未输入有效的 Token，程序退出。');

            logWithTimestamp('error', '也可以通过环境变量 TELEGRAM_BOT_TOKEN 或在 config.js 中设置 telegramToken');

            process.exit(1); // 终止程序

        }

    } else {

        logWithTimestamp('error', '错误: 请设置有效的 Telegram Bot Token！');

        logWithTimestamp('error', '可以通过环境变量 TELEGRAM_BOT_TOKEN 或在 config.js 中设置 telegramToken，');

        logWithTimestamp('error', '或在交互式终端运行本程序后手动输入 Token');

        process.exit(1); // 终止程序

    }

}



// 初始化Telegram Bot，但不立即启动轮询；测试模式下使用 no-op bot

const bot = telegramDisabled ? {

    sendMessage: async (chatId, text) => {

        logWithTimestamp('log', `[Telegram disabled] sendMessage chatId=${chatId}, length=${String(text || '').length}`);

        return { message_id: Date.now() };

    },

    editMessageText: async () => ({}),

    deleteMessage: async () => ({}),

    sendChatAction: async () => ({}),

    answerCallbackQuery: async () => ({}),

    getUpdates: async () => [],

    startPolling: () => {},

    stopPolling: async () => {},

    on: () => {},

} : new TelegramBot(token, { polling: false });

logWithTimestamp('log', telegramDisabled ? 'Telegram Bot 已禁用（测试模式）' : `正在初始化Telegram Bot...（配置来源: ${configSourceName}）`);

// 本 bot 的 username（小写）。用于命令 @botusername 路由与自身回环消息识别。
// getMe() 依赖 Telegram 网络，可能超时失败（api.telegram.org 连接不稳定）。
// 若失败导致 username 未知，bot 将无法识别自己的消息（回环保护失效，且把
// 自己当"其他 bot"）。因此：成功后写入本地缓存；失败时先用缓存兜底再重试。
const BOT_USERNAME_CACHE_FILE = path.join(__dirname, '.bot_username');

function loadCachedBotUsername() {
    try {
        const cached = fs.readFileSync(BOT_USERNAME_CACHE_FILE, 'utf8').trim().toLowerCase();
        return cached || null;
    } catch (e) {
        return null;
    }
}

function saveCachedBotUsername(username) {
    try {
        fs.writeFileSync(BOT_USERNAME_CACHE_FILE, String(username).toLowerCase());
    } catch (e) {
        logWithTimestamp('warn', '写入 Bot 用户名缓存失败:', e.message);
    }
}

// 兜底优先级: config.botUsername > 本地缓存 > getMe() 成功值（getMe 成功会覆盖并刷新缓存）
let myBotUsername = config.botUsername ? String(config.botUsername).toLowerCase().replace(/^@/, '') : null;
if (myBotUsername) logWithTimestamp('log', `使用 config 定义的 Bot 用户名: @${myBotUsername}（getMe 成功后将被覆盖）`);
if (!telegramDisabled) {
    const tryGetMe = (attempt = 0) => {
        bot.getMe()
            .then(me => {
                myBotUsername = (me && me.username ? me.username.toLowerCase() : null);
                if (myBotUsername) saveCachedBotUsername(myBotUsername);
                logWithTimestamp('log', `Telegram Bot 已连接: @${me.username}`);
            })
            .catch(err => {
                // getMe 失败：用缓存用户名兜底，保持回环过滤与 @ 路由生效
                if (!myBotUsername) {
                    myBotUsername = loadCachedBotUsername();
                    if (myBotUsername) {
                        logWithTimestamp('warn', `获取 Bot 信息失败，已用缓存用户名 @${myBotUsername}（回环过滤与 @ 路由保持生效）: ${err.message}`);
                        return; // 有缓存即可工作；后续 getMe 成功会刷新缓存
                    }
                }
                if (myBotUsername) {
                    // config 已定义（或已有兜底值），识别不降级，无需重试告警
                    logWithTimestamp('warn', `获取 Bot 信息失败，使用当前可用用户名 @${myBotUsername}（config/缓存兜底）: ${err.message}`);
                    return;
                }
                logWithTimestamp('warn', `获取 Bot 信息失败（无可用用户名，回环过滤暂时降级）: ${err.message}`);
                if (attempt < 5) {
                    setTimeout(() => tryGetMe(attempt + 1), 30000); // 30s 后重试，最多 5 次
                }
            });
    };
    tryGetMe();
}

// 手动清除所有未处理的消息，然后启动轮询
if (!telegramDisabled) {
(async function clearAndStartPolling() {
    try {
        logWithTimestamp('log', '正在清除Telegram消息队列...');

        // 检查是否是重启，如果是则使用更彻底的清除方式
        const isRestart = process.env.TELEGRAM_CLEAR_UPDATES === '1';
        if (isRestart) {
            logWithTimestamp('log', '检测到重启标记，将执行更彻底的消息队列清理...');
            // 获取更新并丢弃所有消息
            let updates;
            let lastUpdateId = 0;

            // 循环获取所有更新直到没有更多更新
            do {
                updates = await bot.getUpdates({
                    offset: lastUpdateId,
                    limit: 100,
                    timeout: 0
                });

                if (updates && updates.length > 0) {
                    lastUpdateId = updates[updates.length - 1].update_id + 1;
                    logWithTimestamp('log', `清理了 ${updates.length} 条消息，当前offset: ${lastUpdateId}`);
                }
            } while (updates && updates.length > 0);

            // 清除环境变量
            delete process.env.TELEGRAM_CLEAR_UPDATES;
            logWithTimestamp('log', '消息队列清理完成');
        } else {
            // 普通启动时的清理
            const updates = await bot.getUpdates({ limit: 100, timeout: 0 });
            if (updates && updates.length > 0) {
                // 如果有更新，获取最后一个更新的ID并设置offset为它+1
                const lastUpdateId = updates[updates.length - 1].update_id;
                await bot.getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
                logWithTimestamp('log', `已清除 ${updates.length} 条待处理消息`);
            } else {
                logWithTimestamp('log', '没有待处理消息需要清除');
            }
        }

        // 启动轮询
        bot.startPolling({
            restart: true,
            clean: true
        });
        logWithTimestamp('log', 'Telegram Bot轮询已启动');
    } catch (error) {
        logWithTimestamp('error', '清除消息队列或启动轮询时出错:', error);
        // 如果清除失败，仍然尝试启动轮询
        bot.startPolling({ restart: true, clean: true });
        logWithTimestamp('log', 'Telegram Bot轮询已启动（清除队列失败后）');
    }
})();
} else {
    logWithTimestamp('log', '跳过 Telegram 消息队列清理与 polling 启动。');
}

// 初始化WebSocket服务器
const wss = new WebSocket.Server({ port: wssPort });
logWithTimestamp('log', `WebSocket服务器正在监听端口 ${wssPort}...`);

let sillyTavernClient = null; // 用于存储连接的SillyTavern扩展客户端
let lastActiveChatId = null; // 最近活跃的Telegram聊天（用于酒馆本地生成的双向同步）

// 心跳定时器
let heartbeatInterval = null;

// 心跳配置
const HEARTBEAT_INTERVAL = config.heartbeat?.interval || 30000; // 30秒

// 用于存储正在进行的流式会话，调整会话结构，使用Promise来处理messageId
// 结构: { messagePromise: Promise<number> | null, lastText: String, timer: NodeJS.Timeout | null, isEditing: boolean, typingInterval: NodeJS.Timeout | null, charCount: number }
const ongoingStreams = new Map();

// Bridge runtime profile/model configuration
const BRIDGE_CONFIG_PATH = process.env.BRIDGE_CONFIG_PATH || path.join(__dirname, 'bridge-profiles.json');
const BRIDGE_PRIVATE_CONFIG_PATH = process.env.BRIDGE_PRIVATE_CONFIG_PATH || path.join(__dirname, 'bridge-custom-profiles.private.json');
let bridgeRuntimeConfig = { models: {}, profiles: {}, providers: {}, options: {} };
let bridgePrivateConfig = { providers: {} };

function loadBridgeRuntimeConfig() {
    try {
        if (!fs.existsSync(BRIDGE_CONFIG_PATH)) {
            bridgeRuntimeConfig = { models: {}, profiles: {} };
            logWithTimestamp('warn', `Bridge配置文件不存在: ${BRIDGE_CONFIG_PATH}，将使用空配置。`);
            return bridgeRuntimeConfig;
        }
        const parsed = JSON.parse(fs.readFileSync(BRIDGE_CONFIG_PATH, 'utf8'));
        bridgeRuntimeConfig = {
            models: parsed.models && typeof parsed.models === 'object' ? parsed.models : {},
            profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
            providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {},
            options: parsed.options && typeof parsed.options === 'object' ? parsed.options : {},
        };
        logWithTimestamp('log', `Bridge配置已加载: models=${Object.keys(bridgeRuntimeConfig.models).length}, profiles=${Object.keys(bridgeRuntimeConfig.profiles).length}`);
        return bridgeRuntimeConfig;
    } catch (error) {
        logWithTimestamp('error', `Bridge配置加载失败: ${error.message}`);
        return bridgeRuntimeConfig;
    }
}

function loadBridgePrivateConfig() {
    try {
        if (!fs.existsSync(BRIDGE_PRIVATE_CONFIG_PATH)) {
            bridgePrivateConfig = { providers: {} };
            return bridgePrivateConfig;
        }
        const parsed = JSON.parse(fs.readFileSync(BRIDGE_PRIVATE_CONFIG_PATH, 'utf8'));
        bridgePrivateConfig = {
            providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {},
        };
        logWithTimestamp('log', `Bridge私有连接配置已加载: providers=${Object.keys(bridgePrivateConfig.providers).length}`);
    } catch (error) {
        bridgePrivateConfig = { providers: {} };
        logWithTimestamp('error', `Bridge私有连接配置加载失败: ${error.message}`);
    }
    return bridgePrivateConfig;
}

function clonePublicConfig() {
    return JSON.parse(JSON.stringify(bridgeRuntimeConfig || { models: {}, profiles: {}, providers: {}, options: {} }));
}

function resolveProviderIdFromArgs(args = []) {
    const text = String((args || []).join(' ') || '').trim();
    const entries = Object.entries((bridgeRuntimeConfig && bridgeRuntimeConfig.providers) || {})
        .filter(([, provider]) => provider && provider.enabled !== false);
    if (!text) return null;
    if (/^\d+$/.test(text)) {
        const found = entries[Number(text) - 1];
        return found ? found[0] : null;
    }
    const found = entries.find(([id, provider]) =>
        id.toLowerCase() === text.toLowerCase()
        || String(provider.label || '').toLowerCase() === text.toLowerCase()
        || String(provider.source || '').toLowerCase() === text.toLowerCase()
    );
    return found ? found[0] : null;
}

function getBridgeRuntimeConfigForClient(command, args = []) {
    const publicConfig = clonePublicConfig();
    if (command === 'provider') {
        const providerId = resolveProviderIdFromArgs(args);
        const secret = providerId && bridgePrivateConfig.providers ? bridgePrivateConfig.providers[providerId] : null;
        if (secret && secret.apiKey) {
            publicConfig.selectedProviderSecret = { id: providerId, apiKey: secret.apiKey };
        }
    }
    return publicConfig;
}

loadBridgeRuntimeConfig();
loadBridgePrivateConfig();

function sendBridgeExecuteCommand(command, args, chatId) {
    if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
        sendLongMessage(bot, chatId, 'SillyTavern未连接，无法执行该命令。请先确保SillyTavern已打开并启用了Telegram扩展。');
        return false;
    }
    sillyTavernClient.send(JSON.stringify({
        type: 'execute_command',
        command,
        args,
        chatId,
        bridgeConfig: getBridgeRuntimeConfigForClient(command, args),
    }));
    return true;
}

function isBridgeControlCommand(command) {
    return [
        'models', 'model', 'presets', 'preset', 'profiles', 'profile',
        'providers', 'provider', 'provider_models', 'provider-models', 'provider_model', 'provider-model',
        'bridge_status', 'bridge-reload', 'bridge_reload',
    ].includes(command)
        || /^model_/.test(command)
        || /^preset_\d+$/.test(command)
        || /^profile_/.test(command)
        || /^provider_/.test(command);
}

// 流式输出配置
const TYPING_INTERVAL = 4000; // 每4秒发送一次typing状态
const MIN_CHARS_BEFORE_DISPLAY = config.streaming?.minCharsBeforeDisplay || 50; // 最小显示字符数
const STREAM_SESSION_TTL_MS = 60000; // 流式会话兜底清理TTL：stream_end 后若最终更新未到达，超时删除残留会话

function formatStreamProgress(text, steps) {
    const progress = Math.max(1, Math.min(12, steps || 1));
    const suffix = `\n\n${'#'.repeat(progress)}(${progress}/12)`;
    const body = text.length + suffix.length > 4096
        ? `${text.substring(0, 4096 - suffix.length - 3)}...`
        : text;
    return `${body}${suffix}`;
}

// --- 心跳管理函数 ---
/**
 * 启动心跳检测，每30秒发送心跳消息到客户端
 * @param {WebSocket} ws - WebSocket连接实例
 */
function startHeartbeat(ws) {
    // 先清理可能存在的旧定时器
    stopHeartbeat();

    logWithTimestamp('log', `启动心跳检测，间隔: ${HEARTBEAT_INTERVAL}ms`);

    heartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            const heartbeatMessage = {
                type: 'heartbeat',
                timestamp: Date.now()
            };
            ws.send(JSON.stringify(heartbeatMessage));
            logWithTimestamp('log', '发送心跳包');
        } else {
            // 连接已关闭，停止心跳
            stopHeartbeat();
        }
    }, HEARTBEAT_INTERVAL);
}

/**
 * 停止心跳检测，清理定时器
 */
function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        logWithTimestamp('log', '心跳检测已停止');
    }
}

/**
 * 启动持续"输入中"状态，每4秒发送一次typing状态
 * @param {number} chatId - Telegram聊天ID
 * @returns {NodeJS.Timeout} - 定时器ID
 */
function startTypingInterval(chatId) {
    // 立即发送一次typing状态
    bot.sendChatAction(chatId, 'typing').catch(error =>
        logWithTimestamp('error', '发送"输入中"状态失败:', error));

    // 每4秒发送一次typing状态
    return setInterval(() => {
        bot.sendChatAction(chatId, 'typing').catch(error =>
            logWithTimestamp('error', '发送"输入中"状态失败:', error));
    }, TYPING_INTERVAL);
}

/**
 * 停止"输入中"状态定时器
 * @param {NodeJS.Timeout} interval - 定时器ID
 */
function stopTypingInterval(interval) {
    if (interval) {
        clearInterval(interval);
    }
}

// 重载服务器函数
function reloadServer(chatId) {
    logWithTimestamp('log', '重载服务器端组件...');
    Object.keys(require.cache).forEach(function (key) {
        if (key.indexOf('node_modules') === -1) {
            delete require.cache[key];
        }
    });
    try {
        // 与启动逻辑保持一致：没有 config.js 时回退到 config.example.js
        const reloadPath = fs.existsSync(configPath) ? './config.js' : './config.example.js';
        delete require.cache[require.resolve(reloadPath)];
        const newConfig = require(reloadPath);
        Object.assign(config, newConfig);
        logWithTimestamp('log', `配置文件已重新加载 (${reloadPath})`);
    } catch (error) {
        logWithTimestamp('error', '重新加载配置文件时出错:', error);
        if (chatId) bot.sendMessage(chatId, '重新加载配置文件时出错: ' + error.message);
        return;
    }
    logWithTimestamp('log', '服务器端组件已重载');
    // 不发送成功通知：/reload 已向请求者发送过"正在重载..."，避免重复确认消息
}

// 重启服务器函数
function restartServer(chatId) {
    logWithTimestamp('log', '重启服务器端组件...');

    // 首先停止Telegram Bot轮询
    bot.stopPolling().then(() => {
        logWithTimestamp('log', 'Telegram Bot轮询已停止');

        // 然后关闭WebSocket服务器
        if (wss) {
            wss.close(() => {
                logWithTimestamp('log', 'WebSocket服务器已关闭，准备重启...');
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `重启服务器: ${serverPath}`);
                    const cleanEnv = {
                        PATH: process.env.PATH,
                        NODE_PATH: process.env.NODE_PATH,
                        TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                    };
                    if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                    const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                    child.unref();
                    process.exit(0);
                }, 1000);
            });
        } else {
            // 如果没有WebSocket服务器，直接重启
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                logWithTimestamp('log', `重启服务器: ${serverPath}`);
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                };
                if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        }
    }).catch(err => {
        logWithTimestamp('error', '停止Telegram Bot轮询时出错:', err);
        // 即使出错也继续重启过程
        if (wss) {
            wss.close(() => {
                // 重启代码...
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `重启服务器: ${serverPath}`);
                    const cleanEnv = {
                        PATH: process.env.PATH,
                        NODE_PATH: process.env.NODE_PATH,
                        TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                    };
                    if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                    const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                    child.unref();
                    process.exit(0);
                }, 1000);
            });
        } else {
            // 如果没有WebSocket服务器，直接重启
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                logWithTimestamp('log', `重启服务器: ${serverPath}`);
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                };
                if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        }
    });
}

// 退出服务器函数
function exitServer() {
    logWithTimestamp('log', '正在关闭服务器...');
    const forceExitTimeout = setTimeout(() => {
        logWithTimestamp('error', '退出操作超时，强制退出进程');
        process.exit(1);
    }, 10000);
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            fs.unlinkSync(RESTART_PROTECTION_FILE);
            logWithTimestamp('log', '已清理重启保护文件');
        }
    } catch (error) {
        logWithTimestamp('error', '清理重启保护文件失败:', error);
    }
    const finalExit = () => {
        clearTimeout(forceExitTimeout);
        logWithTimestamp('log', '服务器端组件已成功关闭');
        process.exit(0);
    };
    if (wss) {
        wss.close(() => {
            logWithTimestamp('log', 'WebSocket服务器已关闭');
            bot.stopPolling().finally(finalExit);
        });
    } else {
        bot.stopPolling().finally(finalExit);
    }
}

function handleSystemCommand(command, chatId) {
    logWithTimestamp('log', `执行系统命令: ${command}`);

    // 处理 ping 命令 - 返回连接状态信息
    if (command === 'ping') {
        const bridgeStatus = 'Bridge状态：已连接 ✅';
        const stStatus = sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN ?
            'SillyTavern状态：已连接 ✅' :
            'SillyTavern状态：未连接 ❌';
        bot.sendMessage(chatId, `${bridgeStatus}\n${stStatus}`);
        return;
    }

    let responseMessage = '';
    switch (command) {
        case 'reload':
            responseMessage = '正在重载服务器端组件...';
            // 如果SillyTavern已连接，则执行刷新UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // 如果未连接，直接重载服务器
                bot.sendMessage(chatId, responseMessage);
                reloadServer(chatId);
            }
            break;
        case 'restart':
            responseMessage = '正在重启服务器端组件...';
            // 如果SillyTavern已连接，则执行刷新UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // 如果未连接，直接重启服务器
                bot.sendMessage(chatId, responseMessage);
                restartServer(chatId);
            }
            break;
        case 'exit':
            responseMessage = '正在关闭服务器端组件...';
            // 如果SillyTavern已连接，则执行刷新UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // 如果未连接，直接退出服务器
                bot.sendMessage(chatId, responseMessage);
                exitServer();
            }
            break;
        default:
            // 未知命令静默忽略，不回复（避免群聊噪音）
            logWithTimestamp('log', `未知系统命令 /${command} 已忽略（静默）`);
            return;
    }

    // 只有在SillyTavern已连接的情况下，消息才会在上面的switch语句中发送
    // 所以这里只在SillyTavern已连接时发送响应消息
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        bot.sendMessage(chatId, responseMessage);
    }
}

// 处理Telegram命令
async function handleTelegramCommand(command, args, chatId, userId = chatId) {
    logWithTimestamp('log', `处理Telegram命令: /${command} ${args.join(' ')}`);

    // 显示"输入中"状态
    bot.sendChatAction(chatId, 'typing').catch(error =>
        logWithTimestamp('error', '发送"输入中"状态失败:', error));

    // 默认回复（未知命令不回复，静默忽略）
    let replyText = '';

    // 特殊处理help命令，显示带按钮的菜单
    if (command === 'help') {
        replyText = `🤖 SillyTavern Telegram Bridge\n\n点击下方按钮快速操作，或使用命令：`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📋 角色列表', callback_data: 'cmd_listchars' },
                    { text: '💬 聊天记录', callback_data: 'cmd_listchats' }
                ],
                [
                    { text: '🆕 新建聊天', callback_data: 'cmd_new' },
                    { text: '📡 连接状态', callback_data: 'cmd_ping' }
                ],
                [
                    { text: '🔌 供应商切换', callback_data: 'cmd_providers' },
                    { text: '🤖 模型选择', callback_data: 'cmd_models' }
                ],
                [
                    { text: '🧩 当前源模型', callback_data: 'cmd_provider_models' },
                    { text: '🎛️ 预设切换', callback_data: 'cmd_presets' }
                ],
                [
                    { text: '⚡ 模式档案', callback_data: 'cmd_profiles' },
                    { text: '📊 Bridge状态', callback_data: 'cmd_bridge_status' }
                ],
                [
                    { text: '📤 上传导入', callback_data: 'cmd_upload' }
                ],
                [
                    { text: '🔄 重载服务', callback_data: 'cmd_reload' },
                    { text: '❓ 命令帮助', callback_data: 'cmd_helptext' }
                ]
            ]
        };

        bot.sendMessage(chatId, replyText, { reply_markup: keyboard });
        return;
    }

    // 显示详细帮助文本
    if (command === 'helptext') {
        replyText = `📖 命令列表：\n\n`;
        replyText += `💬 聊天管理\n`;
        replyText += `/new - 开始新聊天\n`;
        replyText += `/listchats [页码] - 聊天记录列表\n`;
        replyText += `/switchchat - 显示聊天记录切换按钮\n`;
        replyText += `/switchchat_<序号> - 切换聊天\n\n`;
        replyText += `👤 角色管理\n`;
        replyText += `/listchars [页码] - 角色列表\n`;
        replyText += `/switchchar - 显示角色切换按钮\n`;
        replyText += `/switchchar_<序号> - 切换角色\n\n`;
        replyText += `📤 上传导入\n`;
        replyText += `/upload - 上传导入角色卡/预设\n\n`;
        replyText += `⚙️ 系统管理\n`;
        replyText += `/ping - 连接状态\n`;
        replyText += `/reload - 重载服务\n`;
        replyText += `/restart - 重启服务\n`;
        replyText += `/exit - 退出服务`;

        sendLongMessage(bot, chatId, replyText);
        return;
    }

    if (command === 'upload') {

        bot.sendMessage(chatId, '请选择要导入的类型：\n\n角色卡支持 PNG / JSON；预设文件第一版支持 OpenAI/Chat Completion JSON。', { reply_markup: getUploadMenuKeyboard() });

        return;

    }



    if (command === 'upload_character' || command === 'upload_preset' || command === 'upload_auto') {

        const mode = command.replace('upload_', '');

        setUploadSession(chatId, userId, mode);

        const modeText = mode === 'character' ? '角色卡文件（PNG / JSON）' : mode === 'preset' ? '预设 JSON 文件' : '可识别文件（PNG / JSON）';

        bot.sendMessage(chatId, `请在 5 分钟内发送${modeText}。\n\n请以“文件/Document”方式发送，避免 Telegram 压缩图片。`);

        return;

    }



    if (command === 'upload_cancel') {

        clearUploadSession(chatId, userId, true);

        bot.sendMessage(chatId, '已取消上传导入。');

        return;

    }



    // Bridge runtime config reload: server-side first, then notify frontend if connected

    if (command === 'bridge-reload' || command === 'bridge_reload') {

        loadBridgeRuntimeConfig();

        loadBridgePrivateConfig();

        if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {

            sendBridgeExecuteCommand('bridge_reload', args, chatId);

        } else {

            sendLongMessage(bot, chatId, `Bridge配置已重载。\n模型别名: ${Object.keys(bridgeRuntimeConfig.models || {}).length}\nProfiles: ${Object.keys(bridgeRuntimeConfig.profiles || {}).length}\nSillyTavern当前未连接，前端状态未回读。`);

        }

        return;

    }



    // Model / preset / profile commands are executed in SillyTavern frontend context

    if (isBridgeControlCommand(command)) {

        sendBridgeExecuteCommand(command, args, chatId);

        return;

    }



    // 检查SillyTavern是否连接（未连接时只在终端提示，不向 Telegram 回复，避免群聊刷屏）

    if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
        logWithTimestamp('warn', `命令 /${command} 被忽略：SillyTavern扩展未连接（chatId: ${chatId}）`);
        return;
    }

    // 根据命令类型处理
    switch (command) {
        case 'new':
            // 发送命令到前端执行
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'new',
                chatId: chatId
            }));
            return; // 前端会发送响应，所以这里直接返回
        case 'listchars':
            // 发送命令到前端执行（传递页码参数）
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'listchars',
                args: args,
                chatId: chatId
            }));
            return;
        case 'switchchar':
            if (args.length === 0) {
                // 无参数时直接打开角色列表，使用现有分页 + inline buttons 作为切换菜单
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'listchars',
                    args: [],
                    chatId: chatId
                }));
                return;
            } else {
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchar',
                    args: args,
                    chatId: chatId
                }));
                return;
            }
        case 'listchats':
            // 发送命令到前端执行（传递页码参数）
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'listchats',
                args: args,
                chatId: chatId
            }));
            return;
        case 'switchchat':
            if (args.length === 0) {
                // 无参数时直接打开当前角色的聊天记录列表，使用现有分页 + inline buttons 作为切换菜单
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'listchats',
                    args: [],
                    chatId: chatId
                }));
                return;
            } else {
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchat',
                    args: args,
                    chatId: chatId
                }));
                return;
            }
        default:
            // 处理特殊格式的命令，如 switchchar_1, switchchat_2 等
            const charMatch = command.match(/^switchchar_(\d+)$/);
            if (charMatch) {
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: command, // 保持原始命令格式
                    chatId: chatId
                }));
                return;
            }

            const chatMatch = command.match(/^switchchat_(\d+)$/);
            if (chatMatch) {
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: command, // 保持原始命令格式
                    chatId: chatId
                }));
                return;
            }
    }

    // 未知命令：replyText 为空，静默忽略不回复（避免群聊噪音）
    if (!replyText) {
        logWithTimestamp('log', `未知命令 /${command} 已忽略（静默）`);
        return;
    }
    // 发送回复（支持超长消息分割）
    sendLongMessage(bot, chatId, replyText);
}

// --- WebSocket服务器逻辑 ---
wss.on('connection', ws => {
    logWithTimestamp('log', 'SillyTavern扩展已连接！');
    sillyTavernClient = ws;

    // 启动心跳检测
    startHeartbeat(ws);

    ws.on('message', async (message) => { // 将整个回调设为async
        if (sillyTavernClient !== ws) return;
        let data; // 在 try 块外部声明 data
        try {
            data = JSON.parse(message);

            // Protocol-level fail-closed guard for classified SillyTavern system output.
            // The extension normally suppresses this before forwarding it; keep every
            // Telegram send branch protected if a marked payload reaches the bridge.
            if (data.is_system === true) {
                logWithTimestamp('log', `已抑制系统/脏消息，type=${data.type || 'unknown'}, chatId=${data.chatId || 'unknown'}, text=${String(data.text || '')}`);
                return;
            }

            // --- 处理心跳响应 ---
            if (data.type === 'heartbeat_ack') {
                logWithTimestamp('log', '收到心跳响应');
                return;
            }

            // --- 处理流式文本块 ---
            if (data.type === 'stream_chunk' && data.chatId) {
                let session = ongoingStreams.get(data.chatId);

                // 残留会话检测：上一轮流式已结束（stream_end 已停止 typing）但
                // final_message_update 未到达时会话残留，并携带旧 messageId。
                // 若此时复用，新一轮回复会去编辑上一条旧消息（覆盖旧内容）。
                // 检测到残留即重建会话，确保新一轮回复发送新消息。
                if (session && session.typingInterval === null) {
                    logWithTimestamp('warn', `检测到残留流式会话 ChatID ${data.chatId}，重建会话（避免覆盖旧消息）`);
                    ongoingStreams.delete(data.chatId);
                    session = null;
                }

                // 1. 如果会话不存在，立即同步创建一个占位会话
                if (!session) {
                    logWithTimestamp('log', `创建新会话，ChatID: ${data.chatId}`);

                    // 使用let声明，以便在Promise内部访问
                    let resolveMessagePromise;
                    const messagePromise = new Promise(resolve => {
                        resolveMessagePromise = resolve;
                    });

                    // 启动持续"输入中"状态 (Requirement 3.1)
                    const typingInterval = startTypingInterval(data.chatId);

                    session = {
                        messagePromise: messagePromise,
                        resolveMessagePromise: resolveMessagePromise, // 保存 resolve 函数
                        messageId: null, // 直接存储 messageId
                        lastText: data.text,
                        timer: null,
                        isEditing: false,
                        sendingInitial: false, // 标记是否正在发送初始消息
                        typingInterval: typingInterval,
                        charCount: data.text ? data.text.length : 0,
                        editPromise: null,
                        progressSteps: data.text ? 1 : 0,
                        lastProgressText: data.text || '',
                    };
                    ongoingStreams.set(data.chatId, session);

                    // 只有当字符数超过阈值时才发送初始消息 (Requirement 3.2)
                    // 提及消息（data.mentioned）跳过阈值立即发送，不让对方干等
                    if (session.charCount >= MIN_CHARS_BEFORE_DISPLAY || data.mentioned) {
                        session.sendingInitial = true;
                        logWithTimestamp('log', `字符数 ${session.charCount} 超过阈值，发送初始消息...`);
                        // 截断过长的文本，避免超过 Telegram 限制
                        const displayText = formatStreamProgress(data.text, session.progressSteps);
                        bot.sendMessage(data.chatId, displayText)
                            .then(sentMessage => {
                                logWithTimestamp('log', `初始消息发送成功，messageId: ${sentMessage.message_id}`);
                                session.messageId = sentMessage.message_id;
                                resolveMessagePromise(sentMessage.message_id);
                            }).catch(err => {
                                logWithTimestamp('error', '发送初始Telegram消息失败:', err.message);
                                session.sendingInitial = false;
                                stopTypingInterval(session.typingInterval);
                                ongoingStreams.delete(data.chatId);
                                resolveMessagePromise(null); // 避免 messagePromise 永悬
                            });
                    }
                } else {
                    // 2. 如果会话存在，更新最新文本和字符计数
                    session.lastText = data.text;
                    session.charCount = data.text ? data.text.length : 0;
                    if (data.text) {
                        session.progressSteps = Math.min(12, (session.progressSteps || 0) + 1);
                        session.lastProgressText = data.text;
                    }

                    // 检查是否达到字符阈值且尚未发送初始消息（提及消息跳过阈值）
                    if (!session.messageId && (session.charCount >= MIN_CHARS_BEFORE_DISPLAY || data.mentioned) && !session.sendingInitial) {
                        // 标记正在发送初始消息，避免重复发送
                        session.sendingInitial = true;
                        logWithTimestamp('log', `会话已存在，字符数 ${session.charCount} 超过阈值，发送初始消息...`);

                        // 截断过长的文本
                        const displayText = formatStreamProgress(data.text, session.progressSteps);
                        bot.sendMessage(data.chatId, displayText)
                            .then(sentMessage => {
                                logWithTimestamp('log', `初始消息发送成功，messageId: ${sentMessage.message_id}`);
                                session.messageId = sentMessage.message_id;
                                if (session.resolveMessagePromise) {
                                    session.resolveMessagePromise(sentMessage.message_id);
                                }
                            }).catch(err => {
                                logWithTimestamp('error', '发送初始Telegram消息失败:', err.message);
                                session.sendingInitial = false;
                                if (session.resolveMessagePromise) {
                                    session.resolveMessagePromise(null); // 避免 messagePromise 永悬
                                }
                            });
                    }
                }

                // 3. 尝试触发一次编辑（节流保护）
                // 使用 session.messageId 直接检查
                if (session.messageId && !session.isEditing && !session.timer) {
                    session.timer = setTimeout(() => {
                        const currentSession = ongoingStreams.get(data.chatId);
                        if (currentSession && currentSession.messageId) {
                            currentSession.isEditing = true;
                            // 截断过长的文本
                            const editText = formatStreamProgress(currentSession.lastText, currentSession.progressSteps);
                            currentSession.editPromise = bot.editMessageText(editText, {
                                chat_id: data.chatId,
                                message_id: currentSession.messageId,
                            }).catch(err => {
                                if (!err.message.includes('message is not modified'))
                                    logWithTimestamp('error', '编辑Telegram消息失败:', err.message);
                            }).finally(() => {
                                const latest = ongoingStreams.get(data.chatId);
                                if (latest === currentSession) {
                                    latest.isEditing = false;
                                    latest.editPromise = null;
                                }
                            });
                        }
                        // 会话可能在编辑期间被 final_message_update/cleanup_session 删除
                        if (currentSession) currentSession.timer = null;
                    }, 2000);
                }
                return;
            }

            // --- 处理流式结束信号 ---
            if (data.type === 'stream_end' && data.chatId) {
                const session = ongoingStreams.get(data.chatId);
                // 只有当存在会话时才处理，这表明确实是流式传输
                if (session) {
                    if (session.timer) {
                        clearTimeout(session.timer);
                    }
                    // 停止"输入中"状态 (Requirement 3.1)
                    stopTypingInterval(session.typingInterval);
                    session.typingInterval = null;
                    // 兜底清理：若 final_message_update 未在 TTL 内到达（生成中断/前端异常），
                    // 定时删除残留会话，避免无限残留（内存泄漏 + 复用旧消息）
                    clearTimeout(session.cleanupTimer);
                    session.cleanupTimer = setTimeout(() => {
                        if (ongoingStreams.get(data.chatId) === session) {
                            logWithTimestamp('log', `流式会话 ChatID ${data.chatId} 超时未收到最终更新，已清理残留`);
                            ongoingStreams.delete(data.chatId);
                        }
                    }, STREAM_SESSION_TTL_MS);
                    logWithTimestamp('log', `收到流式结束信号，等待最终渲染文本更新...`);
                    // 注意：我们不在这里清理会话，而是等待final_message_update
                }
                // 如果不存在会话但收到stream_end，这是一个异常情况
                // 可能是由于某些原因会话被提前清理了。
                // 不再发送任何消息：最终文本会通过 final_message_update 发送，
                // 这里补发只会产生重复/垃圾消息。
                else {
                    logWithTimestamp('warn', `收到流式结束信号，但找不到对应的会话 ChatID ${data.chatId}（可能是异常清理，已忽略）`);
                    // 不向 Telegram 发送任何提示消息，避免打扰
                }
                return;
            }

            // --- 处理最终渲染后的消息更新 ---
            if (data.type === 'final_message_update' && data.chatId) {
                logWithTimestamp('log', `收到最终渲染文本，ChatID: ${data.chatId}, 长度: ${data.text?.length || 0}`);
                const session = ongoingStreams.get(data.chatId);

                // 直接把原始消息塞过去：不做 markdown→HTML 转换与内容过滤，
                // 避免复杂回复被转义/过滤导致发送失败或内容被改写
                const rawText = data.text || '';

                // 如果会话存在，说明是流式传输的最终更新
                if (session) {
                    // 停止"输入中"状态 (确保清理)
                    stopTypingInterval(session.typingInterval);

                    // 竞态修复：初始消息可能还在发送中，等待其完成后再原地编辑最终消息。
                    if (!session.messageId && session.sendingInitial && session.messagePromise) {
                        logWithTimestamp('log', `初始消息发送中，等待其完成后再编辑最终消息...`);
                        await session.messagePromise;
                    }

                    if (session.timer) {
                        clearTimeout(session.timer);
                        session.timer = null;
                    }
                    if (session.editPromise) {
                        await session.editPromise;
                    }

                    // 直接使用 session.messageId
                    if (session.messageId) {
                        logWithTimestamp('log', `收到流式最终渲染文本，更新消息 ${session.messageId}`);

                        // 检查消息是否超过 Telegram 限制
                        if (rawText.length > 4000) {
                            logWithTimestamp('log', `消息长度 ${rawText.length} 超过限制，删除原消息并分割发送`);
                            // 删除原来的流式消息
                            await bot.deleteMessage(data.chatId, session.messageId).catch(err => {
                                logWithTimestamp('error', '删除原消息失败:', err.message);
                            });
                            // 原始文本分割发送（无 parse_mode）
                            await sendLongMessage(bot, data.chatId, rawText);
                        } else {
                            // 消息长度正常，直接编辑（纯文本，无 parse_mode）
                            await bot.editMessageText(rawText, {
                                chat_id: data.chatId,
                                message_id: session.messageId,
                            }).catch(err => {
                                if (!err.message.includes('message is not modified')) {
                                    logWithTimestamp('error', '编辑最终Telegram消息失败:', err.message);
                                }
                            });
                        }
                        logWithTimestamp('log', `ChatID ${data.chatId} 的流式传输最终更新已发送。`);
                    } else {
                        // 如果没有messageId，说明字符数未达到阈值，直接发送新消息
                        logWithTimestamp('log', `流式会话未发送初始消息，直接发送最终消息到 ChatID ${data.chatId}`);
                        // 原始文本直发（无 parse_mode）
                        await sendLongMessage(bot, data.chatId, rawText);
                    }
                    // 清理流式会话（取消兜底清理定时器，避免定时器残留）
                    clearTimeout(session.cleanupTimer);
                    ongoingStreams.delete(data.chatId);
                    logWithTimestamp('log', `ChatID ${data.chatId} 的流式会话已完成并清理。`);
                }
                // 如果会话不存在，说明这是一个完整的非流式回复
                else {
                    logWithTimestamp('log', `收到非流式完整回复，直接发送新消息到 ChatID ${data.chatId}`);
                    // 原始文本直发（无 parse_mode）
                    await sendLongMessage(bot, data.chatId, rawText);
                }
                return;
            }

            // --- 其他消息处理逻辑 ---
            if (data.type === 'error_message' && data.chatId) {
                logWithTimestamp('error', `收到SillyTavern的错误报告，将发送至Telegram用户 ${data.chatId}: ${data.text}`);
                await sendLongMessage(bot, data.chatId, data.text);
            } else if (data.type === 'ai_reply' && data.chatId) {
                logWithTimestamp('log', `收到非流式AI回复，发送至Telegram用户 ${data.chatId}`);
                // 确保在发送消息前清理可能存在的流式会话
                if (ongoingStreams.has(data.chatId)) {
                    logWithTimestamp('log', `清理 ChatID ${data.chatId} 的流式会话，因为收到了非流式回复`);
                    ongoingStreams.delete(data.chatId);
                }

                // 检查是否有按钮/分页信息，添加内联键盘
                const sendOptions = {};
                if (data.reply_markup) {
                    sendOptions.reply_markup = data.reply_markup;
                }
                if (data.pagination) {
                    const { currentPage, totalPages, type } = data.pagination;
                    const buttons = [];

                    // 上一页按钮
                    if (currentPage > 1) {
                        buttons.push({ text: '⬅️ 上一页', callback_data: `cmd_${type}_${currentPage - 1}` });
                    }
                    // 下一页按钮
                    if (currentPage < totalPages) {
                        buttons.push({ text: '➡️ 下一页', callback_data: `cmd_${type}_${currentPage + 1}` });
                    }

                    if (buttons.length > 0) {
                        const existingKeyboard = sendOptions.reply_markup?.inline_keyboard || [];
                        sendOptions.reply_markup = {
                            inline_keyboard: [...existingKeyboard, buttons]
                        };
                    }
                }

                // 发送非流式回复
                await bot.sendMessage(data.chatId, data.text, sendOptions).catch(err => {
                    logWithTimestamp('error', `发送非流式AI回复失败: ${err.message}`);
                    // 如果带按钮发送失败，尝试不带按钮发送
                    sendLongMessage(bot, data.chatId, data.text);
                });
            } else if (data.type === 'typing_action' && data.chatId) {
                logWithTimestamp('log', `显示"输入中"状态给Telegram用户 ${data.chatId}`);
                bot.sendChatAction(data.chatId, 'typing').catch(error =>
                    logWithTimestamp('error', '发送"输入中"状态失败:', error));
            } else if (data.type === 'local_reply') {
                // 酒馆本地生成的 AI 回复 → 推送到最近活跃的 Telegram 聊天（双向同步）
                if (!lastActiveChatId) {
                    logWithTimestamp('log', '收到本地生成同步请求，但没有活跃的 Telegram 聊天，已忽略。');
                } else {
                    logWithTimestamp('log', `酒馆本地生成同步 → chatId ${lastActiveChatId}`);
                    // 原始文本直发，不做格式转换
                    await sendLongMessage(bot, lastActiveChatId, data.text || '');
                }
            } else if (data.type === 'command_executed') {
                // 处理前端命令执行结果
                logWithTimestamp('log', `命令 ${data.command} 执行完成，结果: ${data.success ? '成功' : '失败'}`);
                if (data.message) {
                    logWithTimestamp('log', `命令执行消息: ${data.message}`);
                }
            } else if (data.type === 'cleanup_session' && data.chatId) {
                // 处理角色/聊天切换时的会话清理请求 (Requirement 5.4)
                logWithTimestamp('log', `收到会话清理请求，ChatID: ${data.chatId}`);
                const session = ongoingStreams.get(data.chatId);
                if (session) {
                    // 清理定时器
                    if (session.timer) {
                        clearTimeout(session.timer);
                    }
                    clearTimeout(session.cleanupTimer);
                    // 停止"输入中"状态
                    stopTypingInterval(session.typingInterval);
                    // 删除会话
                    ongoingStreams.delete(data.chatId);
                    logWithTimestamp('log', `ChatID ${data.chatId} 的流式会话已被清理（角色/聊天切换）`);
                }
            }
        } catch (error) {
            logWithTimestamp('error', '处理SillyTavern消息时出错:', error);
            // 确保即使在解析JSON失败时也能清理
            if (data && data.chatId) {
                ongoingStreams.delete(data.chatId);
            }
        }
    });

    ws.on('close', () => {
        logWithTimestamp('log', 'SillyTavern扩展已断开连接。');
        if (sillyTavernClient !== ws) return;
        // 停止心跳检测
        stopHeartbeat();
        // 清理所有流式会话的typing定时器
        ongoingStreams.forEach((session) => {
            stopTypingInterval(session.typingInterval);
        });
        if (ws.commandToExecuteOnClose) {
            const { command, chatId } = ws.commandToExecuteOnClose;
            logWithTimestamp('log', `客户端断开连接，现在执行预定命令: ${command}`);
            if (command === 'reload') reloadServer(chatId);
            if (command === 'restart') restartServer(chatId);
            if (command === 'exit') exitServer(chatId);
        }
        sillyTavernClient = null;
        ongoingStreams.clear();
    });

    ws.on('error', (error) => {
        logWithTimestamp('error', 'WebSocket发生错误:', error);
        if (sillyTavernClient !== ws) return;
        // 停止心跳检测
        stopHeartbeat();
        // 清理所有流式会话的typing定时器
        ongoingStreams.forEach((session) => {
            stopTypingInterval(session.typingInterval);
        });
        if (sillyTavernClient) {
            sillyTavernClient.commandToExecuteOnClose = null; // 清除标记，防止意外执行
        }
        sillyTavernClient = null;
        ongoingStreams.clear();
    });
});

// 注意：/restart 的重启完成通知已移除（请求者已收到"正在重启服务器端组件..."）。
// process.env.RESTART_NOTIFY_CHATID 仍由 restartServer 传给子进程，
// 供 checkRestartProtection 在检测到循环重启时发送紧急告警。

// 监听内联键盘按钮回调
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    lastActiveChatId = chatId; // 记录最近活跃的聊天（本地生成双向同步用）

    logWithTimestamp('log', `收到按钮回调: ${data}, 用户: ${userId}`);

    // 检查白名单
    if (config.allowedUserIds && config.allowedUserIds.length > 0) {
        if (!config.allowedUserIds.includes(userId)) {
            bot.answerCallbackQuery(callbackQuery.id, { text: '您无权使用此功能' });
            return;
        }
    }

    // 确认收到回调
    bot.answerCallbackQuery(callbackQuery.id);

    // 处理长消息分页
    if (data.startsWith('page_')) {
        const parts = data.split('_');
        if (parts.length >= 3) {
            const cacheId = `${parts[1]}_${parts[2]}_${parts[3]}`;
            const page = parseInt(parts[4]);
            if (!isNaN(page)) {
                // 删除原消息
                await bot.deleteMessage(chatId, callbackQuery.message.message_id).catch(() => {});
                // 发送新页面
                await sendPagedMessage(bot, chatId, cacheId, page, {});
            }
        }
        return;
    }

    // 解析命令
    if (data.startsWith('cmd_')) {
        const command = data.replace('cmd_', '');

        // 处理模型/预设/Profile命令
        if (data === 'cmd_models' || data === 'cmd_presets' || data === 'cmd_profiles' || data === 'cmd_bridge_status' || data === 'cmd_providers' || data === 'cmd_provider_models') {
            const mapped = data.replace('cmd_', '');
            handleTelegramCommand(mapped, [], chatId, userId);
            return;
        }
        if (data.startsWith('cmd_provider_page_')) {
            handleTelegramCommand('provider_models', [data.replace('cmd_provider_page_', '')], chatId, userId);
            return;
        }
        if (data.startsWith('cmd_provider_model_')) {
            handleTelegramCommand('provider_model', [data.replace('cmd_provider_model_', '')], chatId, userId);
            return;
        }
        if (data.startsWith('cmd_provider_')) {
            handleTelegramCommand('provider', [data.replace('cmd_provider_', '')], chatId, userId);
            return;
        }
        if (data.startsWith('cmd_model_')) {
            handleTelegramCommand('model', [data.replace('cmd_model_', '')], chatId, userId);
            return;
        }
        if (data.startsWith('cmd_preset_')) {
            const presetIndex = data.replace('cmd_preset_', '');
            handleTelegramCommand(`preset_${presetIndex}`, [], chatId, userId);
            return;
        }
        if (data.startsWith('cmd_profile_')) {
            handleTelegramCommand('profile', [data.replace('cmd_profile_', '')], chatId, userId);
            return;
        }
        if (data.startsWith('cmd_switchchar_')) {
            handleTelegramCommand(data.replace('cmd_', ''), [], chatId, userId);
            return;
        }
        if (data.startsWith('cmd_switchchat_')) {
            handleTelegramCommand(data.replace('cmd_', ''), [], chatId, userId);
            return;
        }
        if (data === 'cmd_bridge_reload') {
            handleTelegramCommand('bridge_reload', [], chatId, userId);
            return;
        }
        if (data === 'cmd_upload') {
            handleTelegramCommand('upload', [], chatId, userId);
            return;
        }
        if (data === 'cmd_upload_character' || data === 'cmd_upload_preset' || data === 'cmd_upload_auto' || data === 'cmd_upload_cancel') {
            handleTelegramCommand(data.replace('cmd_', ''), [], chatId, userId);
            return;
        }
        if (data.startsWith('cmd_upload_cancel_')) {
            const uploadId = data.replace('cmd_upload_cancel_', '');
            const pending = pendingUploads.get(uploadId);
            if (pending && pending.userId !== userId) {
                bot.sendMessage(chatId, '这个上传取消不属于当前用户。');
                return;
            }
            if (pending) {
                pendingUploads.delete(uploadId);
                cleanupUploadFile(pending.localPath);
                clearUploadSession(chatId, pending.userId, false);
            }
            bot.sendMessage(chatId, '已取消上传导入。');
            return;
        }
        if (data.startsWith('cmd_upload_import_char_') || data.startsWith('cmd_upload_import_switch_') || data.startsWith('cmd_upload_import_preset_') || data.startsWith('cmd_upload_import_preset_switch_')) {
            let importCommand = '';
            let uploadId = '';
            if (data.startsWith('cmd_upload_import_preset_switch_')) {
                importCommand = 'upload_import_preset_switch';
                uploadId = data.replace('cmd_upload_import_preset_switch_', '');
            } else if (data.startsWith('cmd_upload_import_preset_')) {
                importCommand = 'upload_import_preset';
                uploadId = data.replace('cmd_upload_import_preset_', '');
            } else if (data.startsWith('cmd_upload_import_switch_')) {
                importCommand = 'upload_import_switch';
                uploadId = data.replace('cmd_upload_import_switch_', '');
            } else {
                importCommand = 'upload_import_char';
                uploadId = data.replace('cmd_upload_import_char_', '');
            }
            const pending = pendingUploads.get(uploadId);
            if (pending && pending.userId !== userId) {
                bot.sendMessage(chatId, '这个上传确认不属于当前用户。');
                return;
            }
            if (!pending || Date.now() > pending.expiresAt) {
                if (pending) {
                    pendingUploads.delete(uploadId);
                    cleanupUploadFile(pending.localPath);
                }
                bot.sendMessage(chatId, '上传文件已过期，请重新上传。');
                return;
            }
            const buffer = fs.readFileSync(pending.localPath);
            const payload = {
                type: 'execute_command',
                command: importCommand,
                args: [uploadId],
                chatId,
                bridgeConfig: getBridgeRuntimeConfigForClient(importCommand, [uploadId]),
                upload: {
                    id: uploadId,
                    fileName: pending.fileName,
                    dataBase64: buffer.toString('base64'),
                    detected: pending.detected,
                    switchAfter: importCommand.endsWith('_switch'),
                },
            };
            if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
                bot.sendMessage(chatId, 'SillyTavern未连接，无法导入。');
                return;
            }
            sillyTavernClient.send(JSON.stringify(payload));
            // 不发送"正在导入"提示：导入完成后前端会发送"已导入角色卡/预设：..."结果消息
            pendingUploads.delete(uploadId);
            clearUploadSession(chatId, pending.userId, false);
            cleanupUploadFile(pending.localPath);
            return;
        }

        // 处理分页命令
        if (data.startsWith('cmd_listchars_')) {
            const page = parseInt(data.replace('cmd_listchars_', ''));
            handleTelegramCommand('listchars', [page.toString()], chatId, userId);
            return;
        }
        if (data.startsWith('cmd_listchats_')) {
            const page = parseInt(data.replace('cmd_listchats_', ''));
            handleTelegramCommand('listchats', [page.toString()], chatId, userId);
            return;
        }

        // 处理普通命令
        switch (command) {
            case 'listchars':
            case 'listchats':
            case 'new':
            case 'ping':
            case 'reload':
            case 'helptext':
            case 'models':
            case 'presets':
            case 'profiles':
            case 'providers':
            case 'provider_models':
            case 'provider-models':
            case 'bridge_status':
                handleTelegramCommand(command, [], chatId, userId);
                break;
            default:
                // 未知按钮回调静默忽略（可能是旧版残留按钮）
                logWithTimestamp('log', `未知按钮回调 ${data} 已忽略（静默）`);
        }
    }
});

// 构建引用回复上下文：把被回复的消息（文本/贴纸/图片等）转成可见引文，让 AI 知道回复对象
function buildReplyContext(replyTo) {
    if (!replyTo) return '';
    const sender = replyTo.from ? (replyTo.from.username || replyTo.from.first_name || '未知用户') : '未知用户';
    let quoted = replyTo.text || replyTo.caption || '';
    if (!quoted) {
        if (replyTo.sticker) quoted = `贴纸${replyTo.sticker.emoji ? ' ' + replyTo.sticker.emoji : ''}`;
        else if (replyTo.photo) quoted = '图片';
        else if (replyTo.animation) quoted = 'GIF';
        else if (replyTo.voice) quoted = '语音';
        else if (replyTo.video) quoted = '视频';
        else if (replyTo.document) quoted = `文件: ${replyTo.document.file_name || '未知文件'}`;
    }
    if (!quoted) return '';
    return `[回复 @${sender}: "${String(quoted).slice(0, 200)}"] `;
}

// 监听Telegram消息

bot.on('message', async (msg) => {

    const chatId = msg.chat.id;

    let text = msg.text;

    const userId = msg.from.id;
    lastActiveChatId = chatId; // 记录最近活跃的聊天（本地生成双向同步用）

    // 优先使用用户名，其次显示名，用于 Multiplayer 群组模式的前缀

    const username = msg.from.username || msg.from.first_name || '用户';
    const firstName = msg.from.first_name || ''; // 显示名，供前缀格式 "名字 (@用户名)" 使用

    // 判断是否为群组/超级群组（TelegramGroup 环境）

    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    // --- 机器人消息过滤（防止多 bot 群组刷屏循环 & 双实例回环） ---
    const senderIsBot = !!(msg.from && msg.from.is_bot);
    const senderUsername = (msg.from && msg.from.username ? msg.from.username.toLowerCase() : '');

    // 自身回环：收到本 bot 自己发出的消息（另一实例/转发拾取），必须忽略，否则无限循环烧 token。
    // 注意：不屏蔽其他 bot 的消息 —— 多人群组中其他 AI bot 也是角色，需要转发进 SillyTavern。
    if (senderIsBot && myBotUsername && senderUsername === myBotUsername) {
        logWithTimestamp('warn', `忽略本 bot 自身的回环消息 @${msg.from.username}（可能来自另一实例轮询同一 token）`);
        return;
    }

    // 消息中提到本 bot 用户名 → 标记为提及（随 user_message payload 传给前端）。
    // 前端收到后立即触发回复（跳过合并/缓冲窗口），并在首条 stream_chunk 上
    // 回传 mentioned，让服务器跳过字符阈值立即发送流式初始消息。无时间限制、无全局状态。
    // 提及检测基于原始文本与媒体配文（caption），不含引用回复上下文，避免误触发
    const mentionText = msg.text || msg.caption || '';
    const mentioned = !!(mentionText && myBotUsername && mentionText.toLowerCase().includes(myBotUsername));
    if (mentioned) {
        logWithTimestamp('log', `消息中提到本 bot（@${myBotUsername}），立即触发回复`);
    }



    // 检查聊天白名单是否已配置且不为空（群组场景下按 chatId 控制，防止机器人被拉入无关群组）

    if (config.allowedChatIds && config.allowedChatIds.length > 0) {

        if (!config.allowedChatIds.includes(chatId)) {

            logWithTimestamp('log', `拒绝了来自非白名单聊天 ${chatId} 的访问（群组: ${isGroup}）`);

            // 静默拒绝：不向非白名单聊天回复，避免在无关群组中刷屏，也避免暴露 bot 的存在

            return;

        }

    }



    // 检查用户白名单是否已配置且不为空

    if (config.allowedUserIds && config.allowedUserIds.length > 0) {

        // 如果当前用户的ID不在白名单中

        if (!config.allowedUserIds.includes(userId)) {

            logWithTimestamp('log', `拒绝了来自非白名单用户的访问：\n  - User ID: ${userId}\n  - Username: @${username}\n  - Chat ID: ${chatId}\n  - Message: "${text}"`);

            // 静默拒绝：不向非白名单用户回复，避免在群聊中公开点名造成刷屏

            // 终止后续处理

            return;

        }

    }



    // 处理文件上传（角色卡 / OpenAI 预设导入）

    if (msg.document || msg.photo) {

        if (await handleUploadDocument(msg)) return;

    }

    // 非文本消息（贴纸/图片/GIF/语音/视频/文件）→ 占位描述，让 AI 知道用户发了什么
    if (!text) {
        if (msg.sticker) text = `[贴纸${msg.sticker.emoji ? ' ' + msg.sticker.emoji : ''}]`;
        else if (msg.photo) text = '[图片]';
        else if (msg.animation) text = '[GIF]';
        else if (msg.voice) text = '[语音]';
        else if (msg.video) text = '[视频]';
        else if (msg.document) text = `[文件: ${msg.document.file_name || '未知文件'}]`;
        else return; // 其他无内容类型（位置/联系人等）忽略
    }
    // 媒体配文（图片/文件等的 caption）
    if (msg.caption) {
        text = `${text}\n配文: ${msg.caption}`;
    }



    if (text.startsWith('/')) {

        const parts = text.slice(1).trim().split(/\s+/);

        let command = parts[0].toLowerCase();

        const args = parts.slice(1);

        // 命令 @botusername 路由：多 bot 群组中 /cmd@otherbot 是发给别的 bot 的，直接忽略；
        // /cmd@本bot 去掉后缀正常执行；无后缀保持原行为。
        const atIndex = command.indexOf('@');
        if (atIndex !== -1) {
            const addressedBot = command.slice(atIndex + 1);
            command = command.slice(0, atIndex);
            if (!command) return; // 纯 @mention，忽略
            if (myBotUsername && addressedBot.toLowerCase() !== myBotUsername) {
                logWithTimestamp('log', `忽略命令 /${command}@${addressedBot}：是发给其他 bot 的`);
                return;
            }
        }

        // 系统命令由服务器直接处理

        if (['reload', 'restart', 'exit', 'ping'].includes(command)) {

            handleSystemCommand(command, chatId);

            return;

        }



        // 其他命令也由服务器处理，但可能需要前端执行

        handleTelegramCommand(command, args, chatId, userId);

        return;

    }



    // 引用回复：附带被回复消息的上下文（仅普通消息，命令不附带）
    if (msg.reply_to_message) {
        const ctx = buildReplyContext(msg.reply_to_message);
        if (ctx) text = ctx + text;
    }

    // 处理普通消息

    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {

        logWithTimestamp('log', `从Telegram用户 ${chatId} 收到消息 (${isGroup ? '群组' : '私聊'} @${username}): "${text}"`);

        const payload = JSON.stringify({

            type: 'user_message',

            chatId,

            text,

            username,

            firstName,

            userId,

            isGroup,

            mentioned,

        });

        sillyTavernClient.send(payload);

    } else {

        // SillyTavern 未连接：只在终端提示，不向 Telegram 回复，避免群聊刷屏

        logWithTimestamp('warn', `收到来自 ${chatId} 的消息，但SillyTavern扩展未连接，消息已被忽略: "${text.slice(0, 80)}"`);

        logWithTimestamp('warn', '提示：请在SillyTavern扩展中开启并连接 Telegram 扩展。');

    }

});

// index.js
// SillyTavern Telegram MultiPlayer
//
// 合规性说明（依据官方 Writing-Extensions 文档）：
// - 使用 SillyTavern.getContext() 获取稳定 API（eventSource、extensionSettings 等）
// - 仅对 getContext() 未暴露的 4 个函数做直接 import（script.js 是官方文档认可的写法）
// - 使用 hooks.activate 生命周期钩子（onActivate）替代 jQuery 就绪回调
// - 异步初始化放到 APP_READY 事件之后，避免阻塞应用加载

// 从 script.js 导入 getContext() 未暴露的函数
import {
    sendMessageAsUser,
    doNewChat,
    getPastCharacterChats,
    setExternalAbortController,
    getRequestHeaders,
    characters,
} from "../../../../script.js";

import {
    oai_settings,
    openai_settings,
    openai_setting_names,
    chat_completion_sources,
} from "../../../../scripts/openai.js";

import {
    SECRET_KEYS,
    writeSecret,
} from "../../../../scripts/secrets.js";

const MODULE_NAME = 'SillyTavern-Telegram-Connector';

// 默认设置：Object.freeze 防止意外修改
const DEFAULT_SETTINGS = Object.freeze({
    bridgeUrl: '',                   // 留空 = 自动探测内置 Server（酒馆 Server 插件）；填写则手动连接
    autoConnect: true,
    // ---- Multiplayer 设置 ----
    multiplayerEnabled: true,       // 是否启用群组多人模式（默认开启，可在设置面板关闭）
    userPrefix: '<用户>: ',          // 用户消息前缀格式: '<用户>: ' | '用户: ' | '[用户]: ' | '*用户* '
    defaultMode: 'instant',          // 默认游戏模式: 'instant'(即时) | 'buffered'(缓冲)
    bufferWindowSeconds: 30,         // 缓冲模式：收集窗口（秒）
    bufferMaxMessages: 8,            // 缓冲模式：最多收集消息数，达到立即触发
    // ---- 真实对话行为 ----

    mergeWindowSeconds: 3,           // 即时模式：连续消息合并窗口（秒），0 = 每条消息立即回复

    syncLocalToTelegram: true,       // 酒馆本地生成的 AI 回复也推送到最近活跃的 Telegram 聊天

    // ---- 上下文隔离 ----

    perChatContext: true,            // 每个 TG 聊天独立酒馆上下文（独立角色/聊天记录），防止多群/私聊串上下文

});

let ws = null; // WebSocket实例
let lastProcessedChatId = null; // 当前正在生成的Telegram chatId

// 生成状态标志
let isGenerating = false;

// 消息队列：Multiplayer 下生成期间的新消息先入队，回复完成后按序处理
// 元素: { chatId, text, username, isGroup }
let messageQueue = [];
const MAX_PENDING_MESSAGES = 20;
const RESUME_QUEUE_INTERVAL_MS = 1500;
let lastQueueProcessAt = 0;
let queueResumeTimer = null;

// 缓冲模式：收集一段时间内多名玩家的消息，合并成一条发送给 AI

// 元素: { chatId, parts: [string], timer, lastActivity }

let buffer = null;



// --- 每聊天独立上下文（防止多群/私聊串上下文） ---

// Telegram chatId -> { characterId: number|null, chatName: string }

const chatBindings = new Map();



/** 生成该 TG 聊天专用的酒馆聊天文件名 */

function tgChatName(chatId) {

    const n = Math.abs(Number(chatId) || 0);

    return `tg_${n}`;

}



/** 获取（不存在则创建）某 TG 聊天的上下文绑定 */

function getOrCreateBinding(chatId) {

    let binding = chatBindings.get(chatId);

    if (!binding) {

        binding = { characterId: null, chatName: tgChatName(chatId) };

        chatBindings.set(chatId, binding);

    }

    return binding;

}



/**

 * 确保酒馆当前处于该 TG 聊天绑定的角色 + 聊天记录（独立上下文）。

 * 聊天记录不存在时自动新建并重命名为 tg_<chatId>。

 * @returns {Promise<boolean>} 是否就绪

 */

async function ensureChatBinding(chatId) {

    if (!getSettings().perChatContext) return true;

    const context = SillyTavern.getContext();

    const binding = getOrCreateBinding(chatId);



    try {

        // 1. 确保有角色可选

        if (context.characterId === undefined || context.characterId === null) {

            await context.selectCharacterById(0);

        }

        // 2. 切换角色（绑定过角色的聊天）

        if (binding.characterId != null && binding.characterId >= 0 && context.characterId !== binding.characterId) {

            await context.selectCharacterById(binding.characterId);

        }

        // 3. 确保打开的是该聊天绑定的聊天记录

        if (context.chatId !== binding.chatName) {

            const chats = await getPastCharacterChats(context.characterId);

            const exists = Array.isArray(chats) && chats.some(c => c.file_name === `${binding.chatName}.jsonl`);

            if (exists) {

                await context.openCharacterChat(binding.chatName);

            } else {

                // 不存在：新建并重命名为绑定名

                await doNewChat({ deleteCurrentChat: false });

                const newChatId = context.getCurrentChatId();
                if (newChatId !== binding.chatName) {
                    try {
                        await context.renameChat(newChatId, binding.chatName);
                        const renamedChats = await getPastCharacterChats(context.characterId);
                        const renameSucceeded = Array.isArray(renamedChats)
                            && renamedChats.some(c => c.file_name === `${binding.chatName}.jsonl`);
                        if (!renameSucceeded) {
                            throw new Error(`Renamed chat ${binding.chatName}.jsonl was not found`);
                        }
                    } catch (renameError) {
                        // renameChat 会捕获底层请求错误并正常返回；重读聊天列表确认重命名已生效
                        // 失败时直接用默认聊天名作为绑定，避免每条消息都重试新建+重命名
                        console.error(`[Telegram Bridge] 重命名聊天失败，绑定改用默认名 ${newChatId}:`, renameError);
                        binding.chatName = newChatId;
                    }
                }

            }

        }

        return true;

    } catch (error) {

        console.error(`[Telegram Bridge] 切换独立聊天上下文失败 (chatId=${chatId}):`, error);

        return false;

    }

}

// 心跳超时检测相关变量
let heartbeatTimeoutTimer = null;
const HEARTBEAT_TIMEOUT = 45000; // 45秒超时
let lastHeartbeatTime = null;

// 自动重连相关变量
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 5000; // 5秒延迟
let reconnectTimer = null;
let isReconnecting = false;

// --- 工具函数 ---

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    // 确保新增默认键不丢失（升级兼容）
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function updateStatus(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        statusEl.textContent = `状态： ${message}`;
        statusEl.style.color = color;
    }
}

/**
 * 根据设置的用户名前缀格式，为群组消息添加玩家名前缀
 * @param {object} item - { username, firstName, text }
 * @returns {string} 添加前缀后的文本
 */
function applyUserPrefix(item) {
    const username = item.username;
    const firstName = item.firstName;
    const text = item.text;
    // 防御：过滤空值及 "null"/"undefined" 字符串，避免出现 "null: xxx" 的异常前缀
    if (!username || username === 'null' || username === 'undefined') return text;
    const format = getSettings().userPrefix || '<用户>: ';
    const displayName = username.startsWith('@') ? username.slice(1) : username;
    switch (format) {
        case '用户: ':
            return `${displayName}: ${text}`;
        case '[用户]: ':
            return `[${displayName}]: ${text}`;
        case '*用户* ':
            return `*${displayName}* ${text}`;
        case '名字 (@用户): ':
            // 例: Lin Verse (@lolinverse): 消息
            if (firstName && firstName !== displayName) {
                return `${firstName} (@${displayName}): ${text}`;
            }
            return `@${displayName}: ${text}`;
        case '<用户>: ':
        default:
            return `<${displayName}>: ${text}`;
    }
}

/**
 * 重置心跳超时定时器
 */
function resetHeartbeatTimeout() {
    if (heartbeatTimeoutTimer) {
        clearTimeout(heartbeatTimeoutTimer);
    }
    lastHeartbeatTime = Date.now();
    heartbeatTimeoutTimer = setTimeout(() => {
        console.log('[Telegram Bridge] 心跳超时，连接可能已断开');
        updateStatus('连接超时', 'red');
        if (ws) {
            ws.close();
        }
    }, HEARTBEAT_TIMEOUT);
}

/**
 * 清除心跳超时定时器
 */
function clearHeartbeatTimeout() {
    if (heartbeatTimeoutTimer) {
        clearTimeout(heartbeatTimeoutTimer);
        heartbeatTimeoutTimer = null;
    }
    lastHeartbeatTime = null;
}

/**
 * 处理收到的心跳消息，发送心跳响应
 */
function handleHeartbeat(data) {
    resetHeartbeatTimeout();
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'heartbeat_ack',
            timestamp: data.timestamp
        }));
    }
}

/**
 * 尝试自动重连（最多3次，间隔5秒）
 */
function attemptReconnect() {
    if (isReconnecting) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('[Telegram Bridge] 已达到最大重连次数，停止重连');
        updateStatus('重连失败', 'red');
        reconnectAttempts = 0;
        return;
    }
    isReconnecting = true;
    reconnectAttempts++;
    console.log(`[Telegram Bridge] 将在${RECONNECT_DELAY / 1000}秒后尝试重连 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    updateStatus(`重连中... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, 'orange');
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }
    reconnectTimer = setTimeout(() => {
        isReconnecting = false;
        console.log(`[Telegram Bridge] 正在尝试第${reconnectAttempts}次重连...`);
        connect();
    }, RECONNECT_DELAY);
}

function resetReconnectState() {
    reconnectAttempts = 0;
    isReconnecting = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function cancelReconnect() {
    resetReconnectState();
    console.log('[Telegram Bridge] 已取消自动重连');
}

function reloadPage() {
    window.location.reload();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getBridgeConfig(data = {}) {
    return data.bridgeConfig || { models: {}, profiles: {}, options: {} };
}

function sendBridgeReply(chatId, text, replyMarkup = null) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = { type: 'ai_reply', chatId, text };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    ws.send(JSON.stringify(payload));
}

function base64ToFile(base64, fileName) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], fileName);
}

function safePresetName(fileName) {
    return String(fileName || 'Imported Preset').replace(/\.[^/.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'Imported Preset';
}

function uniquePresetName(baseName) {
    let name = baseName;
    let i = 1;
    while (Object.prototype.hasOwnProperty.call(openai_setting_names, name)) {
        name = `${baseName}_${i++}`;
    }
    return name;
}

async function importBridgeCharacterUpload(upload, switchAfter = false) {
    const { selectCharacterById } = SillyTavern.getContext();
    const file = base64ToFile(upload.dataBase64, upload.fileName);
    const ext = String(upload.fileName || '').split('.').pop().toLowerCase();
    if (!['png', 'json'].includes(ext)) throw new Error(`Unsupported character file: ${ext}`);
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', ext);
    formData.append('preserved_name', safePresetName(upload.fileName));
    const result = await fetch('/api/characters/import', {
        method: 'POST',
        body: formData,
        headers: getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });
    if (!result.ok) throw new Error(`Import failed: HTTP ${result.status}`);
    const data = await result.json();
    if (data.error || !data.file_name) throw new Error('SillyTavern rejected the character file');

    if (switchAfter) {
        await sleep(800);
        const avatarName = `${data.file_name}.png`;
        const index = characters.findIndex(c => c.avatar === avatarName || c.name === data.file_name);
        if (index >= 0) {
            await selectCharacterById(index);
        } else {
            // Fallback: reload to refresh the character list if the imported card is not in the in-memory list yet.
            setTimeout(() => window.location.reload(), 1200);
        }
    } else {
        setTimeout(() => window.location.reload(), 1200);
    }
    return `${data.file_name}.png`;
}

async function importBridgeOpenAIPresetUpload(upload, switchAfter = false) {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    const text = atob(upload.dataBase64);
    let presetBody;
    try {
        presetBody = JSON.parse(text);
    } catch (error) {
        throw new Error('Invalid JSON preset');
    }
    const sensitiveFields = ['api_key', 'api_key_openai', 'api_key_custom', 'custom_url', 'proxy_password', 'reverse_proxy', 'chat_completion_proxy'];
    // For Telegram import, remove endpoint/key-like fields by default. Connection profile switching manages keys separately.
    sensitiveFields.forEach(field => {
        if (Object.prototype.hasOwnProperty.call(presetBody, field)) delete presetBody[field];
    });
    const name = uniquePresetName(safePresetName(upload.fileName));
    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ apiId: 'openai', name, preset: presetBody }),
    });
    if (!response.ok) throw new Error(`Preset save failed: HTTP ${response.status}`);
    const data = await response.json();

    // Keep SillyTavern's in-memory preset registry and DOM select in sync immediately.
    // Otherwise /presets reads stale options until the headless frontend reloads.
    if (!Object.prototype.hasOwnProperty.call(openai_setting_names, data.name)) {
        openai_settings.push(presetBody);
        openai_setting_names[data.name] = openai_settings.length - 1;
    }
    const presetIndex = openai_setting_names[data.name];
    const select = $('#settings_preset_openai');
    let option = select.find('option').filter(function () { return $(this).text() === data.name || $(this).val() === String(presetIndex); });
    if (!option.length) {
        option = $(`<option></option>`).val(String(presetIndex)).text(data.name);
        select.append(option);
    } else {
        option.val(String(presetIndex)).text(data.name);
    }

    if (switchAfter) {
        oai_settings.preset_settings_openai = data.name;
        select.val(String(presetIndex)).trigger('change');
        saveSettingsDebounced();
    }
    return data.name;
}

function getCurrentModelSelector(source = oai_settings.chat_completion_source) {
    const map = {
        [chat_completion_sources.DEEPSEEK]: { selector: '#model_deepseek_select', setting: 'deepseek_model' },
        [chat_completion_sources.CUSTOM]: { selector: '#model_custom_select', input: '#custom_model_id', setting: 'custom_model' },
        [chat_completion_sources.OPENROUTER]: { selector: '#model_openrouter_select', setting: 'openrouter_model' },
        [chat_completion_sources.OPENAI]: { selector: '#model_openai_select', setting: 'openai_model' },
        [chat_completion_sources.CLAUDE]: { selector: '#model_claude_select', setting: 'claude_model' },
        [chat_completion_sources.MAKERSUITE]: { selector: '#model_google_select', setting: 'google_model' },
        [chat_completion_sources.VERTEXAI]: { selector: '#model_vertexai_select', setting: 'vertexai_model' },
        [chat_completion_sources.GROQ]: { selector: '#model_groq_select', setting: 'groq_model' },
        [chat_completion_sources.MISTRALAI]: { selector: '#model_mistralai_select', setting: 'mistralai_model' },
        [chat_completion_sources.COHERE]: { selector: '#model_cohere_select', setting: 'cohere_model' },
        [chat_completion_sources.PERPLEXITY]: { selector: '#model_perplexity_select', setting: 'perplexity_model' },
        [chat_completion_sources.AIMLAPI]: { selector: '#model_aimlapi_select', setting: 'aimlapi_model' },
        [chat_completion_sources.XAI]: { selector: '#model_xai_select', setting: 'xai_model' },
        [chat_completion_sources.POLLINATIONS]: { selector: '#model_pollinations_select', setting: 'pollinations_model' },
        [chat_completion_sources.MOONSHOT]: { selector: '#model_moonshot_select', setting: 'moonshot_model' },
        [chat_completion_sources.COMETAPI]: { selector: '#model_cometapi_select', setting: 'cometapi_model' },
        [chat_completion_sources.CHUTES]: { selector: '#model_chutes_select', setting: 'chutes_model' },
        [chat_completion_sources.SILICONFLOW]: { selector: '#model_siliconflow_select', setting: 'siliconflow_model' },
        [chat_completion_sources.ELECTRONHUB]: { selector: '#model_electronhub_select', setting: 'electronhub_model' },
        [chat_completion_sources.NANOGPT]: { selector: '#model_nanogpt_select', setting: 'nanogpt_model' },
        [chat_completion_sources.MINIMAX]: { selector: '#model_minimax_select', setting: 'minimax_model' },
        [chat_completion_sources.ZAI]: { selector: '#model_zai_select', setting: 'zai_model' },
        [chat_completion_sources.WORKERS_AI]: { selector: '#model_workers_ai_select', setting: 'workers_ai_model' },
    };
    return map[source] || null;
}

function getCurrentModelId() {
    const source = oai_settings.chat_completion_source;
    const info = getCurrentModelSelector(source);
    if (info?.setting && oai_settings[info.setting]) return oai_settings[info.setting];
    if (source === chat_completion_sources.CUSTOM) return oai_settings.custom_model || $('#custom_model_id').val() || '';
    return '';
}

function discoverCurrentModels() {
    const source = oai_settings.chat_completion_source;
    const info = getCurrentModelSelector(source);
    const models = [];
    if (info?.selector && $(info.selector).length) {
        $(info.selector).find('option').each(function () {
            const value = String($(this).val() || '').trim();
            const label = String($(this).text() || value).trim();
            if (value) models.push({ id: value, label });
        });
    }
    const current = getCurrentModelId();
    if (current && !models.some(m => m.id === current)) {
        models.unshift({ id: current, label: current });
    }
    return { source, models };
}

function normalizeUrlForCompare(value) {
    return String(value || '').replace(/\/+$/, '');
}

function getProviderList(config = null) {
    const configured = Object.entries((config && config.providers) || {})
        .filter(([, provider]) => provider && provider.enabled !== false)
        .map(([id, provider], index) => {
            const source = provider.source || id;
            const customUrl = provider.customUrl || '';
            const current = source === chat_completion_sources.CUSTOM && customUrl
                ? oai_settings.chat_completion_source === chat_completion_sources.CUSTOM && normalizeUrlForCompare(oai_settings.custom_url) === normalizeUrlForCompare(customUrl)
                : source === oai_settings.chat_completion_source;
            return {
                index: index + 1,
                id,
                source,
                customUrl,
                defaultModel: provider.defaultModel || '',
                label: provider.label || id,
                current,
                note: provider.note || '',
            };
        });

    // Default behavior: show only Bridge-configured/imported connection profiles, not every SillyTavern-supported source.
    if (configured.length || config?.options?.providersMode === 'configured') {
        return configured;
    }

    const providers = [];
    const select = $('#chat_completion_source');
    if (!select.length) return providers;
    select.find('option').each(function (index) {
        const id = String($(this).val() || '').trim();
        const label = String($(this).text() || id).trim();
        if (id) providers.push({ index: index + 1, id, source: id, customUrl: '', defaultModel: '', label, current: id === oai_settings.chat_completion_source, note: '' });
    });
    return providers;
}
function findProviderByArg(arg, config = null) {
    const providers = getProviderList(config);
    const text = String(arg || '').trim();
    if (/^\d+$/.test(text)) return providers[Number(text) - 1] || null;
    return providers.find(p =>
        p.id.toLowerCase() === text.toLowerCase()
        || p.source.toLowerCase() === text.toLowerCase()
        || p.label.toLowerCase() === text.toLowerCase()
    ) || null;
}

function parseModelListArgs(args = []) {
    const joined = args.join(' ').trim();
    let page = 1;
    let query = '';
    if (/^\d+$/.test(joined)) {
        page = Number(joined);
    } else {
        query = joined.toLowerCase();
        const last = args[args.length - 1];
        if (args.length > 1 && /^\d+$/.test(last)) {
            page = Number(last);
            query = args.slice(0, -1).join(' ').trim().toLowerCase();
        }
    }
    return { page: Math.max(1, page || 1), query };
}

function getFilteredCurrentProviderModels(args = []) {
    const { page, query } = parseModelListArgs(args);
    const discovered = discoverCurrentModels();
    const filtered = query
        ? discovered.models.filter(m => m.id.toLowerCase().includes(query) || m.label.toLowerCase().includes(query))
        : discovered.models;
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    return {
        source: discovered.source,
        query,
        page: currentPage,
        totalPages,
        pageSize,
        total: filtered.length,
        models: filtered.slice(start, start + pageSize).map((m, i) => ({ ...m, index: start + i + 1 })),
    };
}

function resolveCurrentProviderModelArg(arg, args = []) {
    const text = String(arg || '').trim();
    if (!text) return null;
    const list = getFilteredCurrentProviderModels(args);
    if (/^\d+$/.test(text)) {
        const idx = Number(text);
        return list.models.find(m => m.index === idx) || discoverCurrentModels().models[idx - 1] || null;
    }
    return discoverCurrentModels().models.find(m => m.id === text || m.id.toLowerCase() === text.toLowerCase()) || { id: text, label: text };
}

function getPresetList() {
    const presets = [];
    $('#settings_preset_openai option').each(function (index) {
        const value = String($(this).val() || '').trim();
        const name = String($(this).text() || value).trim();
        if (name) presets.push({ index: index + 1, value, name });
    });
    return presets;
}

function findPresetByArg(arg) {
    const presets = getPresetList();
    const text = String(arg || '').trim();
    if (/^\d+$/.test(text)) return presets[Number(text) - 1] || null;
    return presets.find(p => p.name === text || p.value === text) || null;
}

function getEnabledModelEntries(config) {
    return Object.entries(config.models || {}).filter(([, model]) => model && model.enabled !== false);
}

function resolveModelArg(arg, config) {
    const text = String(arg || '').trim();
    if (!text) return null;
    const entries = getEnabledModelEntries(config);
    const byAlias = entries.find(([alias]) => alias.toLowerCase() === text.toLowerCase());
    if (byAlias) return { alias: byAlias[0], ...byAlias[1] };
    const byModel = entries.find(([, model]) => String(model.model || '').toLowerCase() === text.toLowerCase());
    if (byModel) return { alias: byModel[0], ...byModel[1] };
    if (config.options?.allowDiscoveredModels) {
        const discovered = discoverCurrentModels().models.find(m => m.id.toLowerCase() === text.toLowerCase());
        if (discovered) return { alias: discovered.id, label: discovered.label, source: oai_settings.chat_completion_source, model: discovered.id, enabled: true };
    }
    return null;
}

async function switchChatCompletionSourceIfNeeded(source) {
    if (!source || source === oai_settings.chat_completion_source) return;
    const sourceSelect = $('#chat_completion_source');
    if (!sourceSelect.length) throw new Error('找不到 chat_completion_source 控件');
    if (!sourceSelect.find(`option[value="${source}"]`).length) throw new Error(`当前酒馆不支持源: ${source}`);
    sourceSelect.val(source).trigger('change');
    await sleep(800);
}

async function refreshCurrentProviderModelList(expectedModel = '') {
    if (oai_settings.chat_completion_source !== chat_completion_sources.CUSTOM) {
        return discoverCurrentModels().models.length;
    }

    // Clear stale options from the previous custom endpoint before asking SillyTavern to reconnect.
    $('.model_custom_select').empty().append('<option value="">None</option>');
    $('#api_button_openai').trigger('click');

    const started = Date.now();
    let lastSignature = '';
    let stableSince = 0;
    let lastCount = 0;

    while (Date.now() - started < 15000) {
        await sleep(500);
        const models = discoverCurrentModels().models.filter(m => m.id);
        const signature = models.map(m => m.id).join('|');
        lastCount = models.length;

        if (signature && signature === lastSignature) {
            if (!stableSince) stableSince = Date.now();
            // Wait until the list is stable for at least 1.5s. Do not stop just because the default model appeared.
            if (Date.now() - stableSince >= 1500) {
                return models.length;
            }
        } else {
            lastSignature = signature;
            stableSince = signature ? Date.now() : 0;
        }
    }

    return lastCount;
}


async function applyProviderProfile(provider, selectedSecret = null) {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    await switchChatCompletionSourceIfNeeded(provider.source);

    if (provider.source === chat_completion_sources.CUSTOM) {
        if (provider.customUrl) {
            oai_settings.custom_url = provider.customUrl;
            $('#custom_api_url_text').val(provider.customUrl).trigger('input');
        }
        if (selectedSecret?.apiKey) {
            await writeSecret(SECRET_KEYS.CUSTOM, selectedSecret.apiKey, provider.label || provider.id);
        }
        saveSettingsDebounced();
        await refreshCurrentProviderModelList(provider.defaultModel || '');
    }

    if (provider.defaultModel) {
        await switchModelByDefinition({
            source: provider.source,
            model: provider.defaultModel,
            label: provider.defaultModel,
        });
    } else {
        saveSettingsDebounced();
        await sleep(300);
    }
}

async function switchModelByDefinition(definition) {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    if (!definition?.model) throw new Error('模型定义缺少 model 字段');
    await switchChatCompletionSourceIfNeeded(definition.source);
    const source = oai_settings.chat_completion_source;
    const info = getCurrentModelSelector(source);
    if (!info) throw new Error(`当前源 ${source} 暂不支持 Telegram 切模型`);
    if (source === chat_completion_sources.CUSTOM) {
        if (info.selector && $(info.selector).length) {
            const select = $(info.selector);
            if (!select.find(`option[value="${definition.model}"]`).length) select.append(new Option(definition.model, definition.model));
            select.val(definition.model).trigger('change');
        }
        if (info.input && $(info.input).length) $(info.input).val(definition.model).trigger('input');
        oai_settings.custom_model = definition.model;
    } else {
        if (!$(info.selector).length) throw new Error(`找不到模型控件: ${info.selector}`);
        if (!$(info.selector).find(`option[value="${definition.model}"]`).length) throw new Error(`当前模型列表中未发现: ${definition.model}`);
        $(info.selector).val(definition.model).trigger('change');
        if (info.setting) oai_settings[info.setting] = definition.model;
    }
    saveSettingsDebounced();
    await sleep(300);
    const after = getCurrentModelId();
    if (after !== definition.model) throw new Error(`模型切换后回读不一致: ${after || '(空)'}`);
}

async function switchPresetByNameOrIndex(arg) {
    const preset = findPresetByArg(arg);
    if (!preset) throw new Error(`未找到预设: ${arg}`);
    const select = $('#settings_preset_openai');
    if (!select.length) throw new Error('找不到预设选择控件');
    select.val(preset.value).trigger('change');
    saveSettingsDebounced();
    await sleep(700);
    return preset;
}

function buildStatusText(config) {
    const enabledModels = getEnabledModelEntries(config).map(([alias, m]) => `${alias}: ${m.label || m.model} (${m.model})`);
    const profiles = Object.entries(config.profiles || {}).map(([name, p]) => `${name}: ${p.label || name} / model=${p.modelAlias || p.model || '-'} / preset=${p.preset || '-'}`);
    const providers = getProviderList(config).map(p => `${p.id}: ${p.label} -> ${p.source}${p.current ? ' ← 当前' : ''}`);
    return [
        '📊 Bridge状态', '',
        `当前源：${oai_settings.chat_completion_source}`,
        `当前模型：${getCurrentModelId() || '(未设置)'}`,
        `当前预设：${oai_settings.preset_settings_openai || '(未设置)'}`,
        `连接绑定：${oai_settings.bind_preset_to_connection ? '开启' : '关闭'}`, '',
        `已配置供应商：${providers.length || 0}`,
        ...(providers.length ? providers.map(x => `- ${x}`) : []), '',
        `已启用模型：${enabledModels.length || 0}`,
        ...(enabledModels.length ? enabledModels.map(x => `- ${x}`) : []), '',
        `Profiles：${profiles.length || 0}`,
        ...(profiles.length ? profiles.map(x => `- ${x}`) : []),
    ].join('\n');
}

async function handleBridgeControlCommand(data, context) {
    const config = getBridgeConfig(data);
    const command = data.command;
    const args = data.args || [];

    if (command === 'upload_import_char' || command === 'upload_import_switch') {
        try {
            if (!data.upload) throw new Error('Missing upload payload');
            const fileName = await importBridgeCharacterUpload(data.upload, command === 'upload_import_switch');
            const suffix = command === 'upload_import_switch' ? '\n已尝试切换到该角色。' : '\n角色列表将自动刷新。';
            sendBridgeReply(data.chatId, `已导入角色卡：${fileName}${suffix}`);
        } catch (error) {
            console.error('[Telegram Bridge] character import failed', error);
            sendBridgeReply(data.chatId, `角色卡导入失败：${error.message}`);
        }
        return true;
    }

    if (command === 'upload_import_preset' || command === 'upload_import_preset_switch') {
        try {
            if (!data.upload) throw new Error('Missing upload payload');
            const name = await importBridgeOpenAIPresetUpload(data.upload, command === 'upload_import_preset_switch');
            const suffix = command === 'upload_import_preset_switch' ? '\n已切换到该预设。' : '';
            sendBridgeReply(data.chatId, `已导入 OpenAI 预设：${name}${suffix}`);
        } catch (error) {
            console.error('[Telegram Bridge] preset import failed', error);
            sendBridgeReply(data.chatId, `预设导入失败：${error.message}`);
        }
        return true;
    }

    if (isGenerating && !['models', 'presets', 'profiles', 'providers', 'provider_models', 'provider-models', 'bridge_status'].includes(command)) {
        sendBridgeReply(data.chatId, '当前正在生成回复，请生成完成后再切换模型、预设或Profile。');
        return true;
    }
    if (command === 'providers') {
        const providers = getProviderList(config);
        const buttons = providers.map(p => ({ text: `${p.current ? '✓ ' : ''}${p.label}`, callback_data: `cmd_provider_${p.id}` }));
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
        keyboard.push([{ text: '🧩 当前源模型', callback_data: 'cmd_provider_models' }, { text: '📊 当前状态', callback_data: 'cmd_bridge_status' }]);
        const lines = providers.length ? providers.map(p => `${p.index}. ${p.label} (${p.id})${p.current ? ' ← 当前' : ''}`).join('\n') : '(未发现供应商下拉框)';
        sendBridgeReply(data.chatId, `🔌 连接档案列表\n\n当前源：${oai_settings.chat_completion_source}\n\n${lines}\n\n切换：/provider <ID或序号>`, { inline_keyboard: keyboard });
        return true;
    }

    if (command === 'provider') {
        const arg = args.join(' ');
        const provider = findProviderByArg(arg, config);
        if (!provider) {
            sendBridgeReply(data.chatId, `未找到供应商：${arg}\n请用 /providers 查看当前酒馆已有供应商。`);
            return true;
        }
        await applyProviderProfile(provider, config.selectedProviderSecret);
        const discovered = discoverCurrentModels();
        sendBridgeReply(data.chatId, `已切换连接档案：${provider.label} (${provider.source})\nEndpoint：${provider.customUrl || '(当前供应商默认)'}\n当前模型：${getCurrentModelId() || '(未设置)'}\n当前源发现模型数：${discovered.models.length}\n\n查看模型：/provider-models`);
        return true;
    }

    if (command === 'provider_models' || command === 'provider-models') {
        const list = getFilteredCurrentProviderModels(args);
        const buttons = list.models.map(m => ({ text: `${m.index}. ${m.id === getCurrentModelId() ? '✓ ' : ''}${m.label || m.id}`.slice(0, 60), callback_data: `cmd_provider_model_${m.index}` }));
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 1) keyboard.push([buttons[i]]);
        const nav = [];
        if (list.page > 1) nav.push({ text: '⬅️ 上页', callback_data: `cmd_provider_page_${list.page - 1}` });
        if (list.page < list.totalPages) nav.push({ text: '➡️ 下页', callback_data: `cmd_provider_page_${list.page + 1}` });
        if (nav.length) keyboard.push(nav);
        keyboard.push([{ text: '🔌 供应商', callback_data: 'cmd_providers' }, { text: '📊 当前状态', callback_data: 'cmd_bridge_status' }]);
        const lines = list.models.length ? list.models.map(m => `${m.index}. ${m.id}${m.id === getCurrentModelId() ? ' ← 当前' : ''}`).join('\n') : '(当前供应商未发现模型)';
        const q = list.query ? `\n搜索：${list.query}` : '';
        sendBridgeReply(data.chatId, `🧩 当前供应商模型\n\n供应商：${list.source}\n当前模型：${getCurrentModelId() || '(未设置)'}${q}\n页码：${list.page}/${list.totalPages}，共 ${list.total} 个\n\n${lines}\n\n切换：/provider-model <模型ID或序号>`, { inline_keyboard: keyboard });
        return true;
    }

    if (command === 'provider_model' || command === 'provider-model') {
        const arg = args.join(' ');
        const model = resolveCurrentProviderModelArg(arg, args);
        if (!model?.id) {
            sendBridgeReply(data.chatId, `未找到模型：${arg}\n请用 /provider-models 查看当前供应商模型。`);
            return true;
        }
        await switchModelByDefinition({ source: oai_settings.chat_completion_source, model: model.id, label: model.label || model.id });
        sendBridgeReply(data.chatId, `已切换当前供应商模型：${model.id}\n供应商：${oai_settings.chat_completion_source}\n当前模型：${getCurrentModelId() || '(未设置)'}`);
        return true;
    }

    if (command === 'models') {
        const discovered = discoverCurrentModels();
        const enabled = getEnabledModelEntries(config);
        const buttons = enabled.map(([alias, model]) => ({ text: model.label || alias, callback_data: `cmd_model_${alias}` }));
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
        keyboard.push([{ text: '📊 当前状态', callback_data: 'cmd_bridge_status' }]);
        const enabledLines = enabled.length ? enabled.map(([alias, model], i) => `${i + 1}. ${alias} — ${model.label || model.model} (${model.model})`).join('\n') : '(无)';
        const discoveredLines = discovered.models.length ? discovered.models.map((m, i) => `${i + 1}. ${m.id}${m.id === getCurrentModelId() ? ' ← 当前' : ''}`).join('\n') : '(当前源未发现模型下拉列表)';
        sendBridgeReply(data.chatId, `🤖 模型列表\n\n当前源：${discovered.source}\n当前模型：${getCurrentModelId() || '(未设置)'}\n\n已启用：\n${enabledLines}\n\n当前源发现：\n${discoveredLines}\n\n切换：/model <别名或模型ID>`, { inline_keyboard: keyboard });
        return true;
    }
    if (command === 'model' || /^model_/.test(command)) {
        const arg = command.startsWith('model_') ? command.replace(/^model_/, '') : args.join(' ');
        const model = resolveModelArg(arg, config);
        if (!model) { sendBridgeReply(data.chatId, `未找到或未启用模型：${arg}\n请用 /models 查看可用模型。`); return true; }
        await switchModelByDefinition(model);
        sendBridgeReply(data.chatId, `已切换模型：${model.label || model.alias}\n当前源：${oai_settings.chat_completion_source}\n当前模型：${getCurrentModelId()}`);
        return true;
    }
    if (command === 'presets') {
        const presets = getPresetList();
        const buttons = presets.map(p => ({ text: p.name, callback_data: `cmd_preset_${p.index}` }));
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
        keyboard.push([{ text: '📊 当前状态', callback_data: 'cmd_bridge_status' }]);
        const lines = presets.length ? presets.map(p => `${p.index}. ${p.name}${p.name === oai_settings.preset_settings_openai ? ' ← 当前' : ''}`).join('\n') : '(未发现预设)';
        sendBridgeReply(data.chatId, `🎛️ 预设列表\n\n当前预设：${oai_settings.preset_settings_openai || '(未设置)'}\n连接绑定：${oai_settings.bind_preset_to_connection ? '开启' : '关闭'}\n\n${lines}\n\n切换：/preset <名称> 或 /preset_数字`, { inline_keyboard: keyboard });
        return true;
    }
    if (command === 'preset' || /^preset_\d+$/.test(command)) {
        const arg = command.startsWith('preset_') ? command.replace(/^preset_/, '') : args.join(' ');
        const preset = await switchPresetByNameOrIndex(arg);
        sendBridgeReply(data.chatId, `已切换预设：${preset.name}\n当前模型：${getCurrentModelId() || '(未设置)'}\n连接绑定：${oai_settings.bind_preset_to_connection ? '开启' : '关闭'}`);
        return true;
    }
    if (command === 'profiles') {
        const entries = Object.entries(config.profiles || {});
        const buttons = entries.map(([name, profile]) => ({ text: profile.label || name, callback_data: `cmd_profile_${name}` }));
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
        keyboard.push([{ text: '📊 当前状态', callback_data: 'cmd_bridge_status' }]);
        const lines = entries.length ? entries.map(([name, profile], i) => `${i + 1}. ${name} — ${profile.label || name}\n   model=${profile.modelAlias || profile.model || '-'} preset=${profile.preset || '-'}`).join('\n') : '(无)';
        sendBridgeReply(data.chatId, `⚡ Profile列表\n\n${lines}\n\n切换：/profile <名称>`, { inline_keyboard: keyboard });
        return true;
    }
    if (command === 'profile' || /^profile_/.test(command)) {
        const name = command.startsWith('profile_') ? command.replace(/^profile_/, '') : args.join(' ');
        const profile = (config.profiles || {})[name];
        if (!profile) { sendBridgeReply(data.chatId, `未找到Profile：${name}\n请用 /profiles 查看。`); return true; }
        let preset = null;
        if (profile.preset) preset = await switchPresetByNameOrIndex(profile.preset);
        let modelDef = null;
        if (profile.modelAlias) modelDef = resolveModelArg(profile.modelAlias, config);
        else if (profile.model) modelDef = resolveModelArg(profile.model, config) || { source: profile.source, model: profile.model, label: profile.model };
        if (modelDef) await switchModelByDefinition(modelDef);
        sendBridgeReply(data.chatId, `已切换Profile：${profile.label || name}\n当前源：${oai_settings.chat_completion_source}\n当前模型：${getCurrentModelId() || '(未设置)'}\n当前预设：${preset?.name || oai_settings.preset_settings_openai || '(未设置)'}`);
        return true;
    }
    if (command === 'bridge_status' || command === 'bridge_reload') {
        sendBridgeReply(data.chatId, buildStatusText(config));
        return true;
    }
    return false;
}

// --- Multiplayer 消息队列 ---

/**
 * 新消息入口：生成中则入队，否则立即处理
 * @param {object} item - { chatId, text, username, isGroup }
 */
function enqueueOrProcess(item) {
    if (isGenerating) {
        // Compact same-chat backlog without dropping older user content.
        if (messageQueue.length >= MAX_PENDING_MESSAGES) {
            compactPendingMessages();
            const queuedForChat = messageQueue.find(queued => queued.chatId === item.chatId);
            if (queuedForChat) {
                queuedForChat.text = `${queuedForChat.text}\n${item.text}`;
                queuedForChat.username = null;
                queuedForChat.isGroup = false;
                if (item.sticker) queuedForChat.sticker = item.sticker;
                return;
            }
            console.warn(`[Telegram Bridge] 消息积压超过 ${MAX_PENDING_MESSAGES} 个会话，保留新消息等待限速处理。`);
        }
        messageQueue.push(item);
        console.log(`[Telegram Bridge] 正在生成回复，消息已入队。队列长度: ${messageQueue.length}`);
        return;
    }
    processMessage(item);
}

function deferPendingBuffer(bufferItem) {
    if (!bufferItem) return;
    const parts = bufferItem.parts.map(part => typeof part === 'string'
        ? part
        : (part.isGroup ? applyUserPrefix(part) : part.text));
    messageQueue.push({ chatId: bufferItem.chatId, text: parts.join('\n'), username: null, isGroup: false });
}

/** Collapse stale work after an offline interval: one prompt per chat. */
function compactPendingMessages() {
    const compacted = new Map();
    for (const item of messageQueue) {
        const previous = compacted.get(item.chatId);
        if (!previous) {
            compacted.set(item.chatId, { ...item });
        } else {
            previous.text = `${previous.text}\n${item.text}`;
            previous.username = null;
            previous.isGroup = false;
            if (item.sticker) previous.sticker = item.sticker;
        }
    }
    messageQueue = Array.from(compacted.values());
}

/** Process at a bounded rate so expired sleep timers cannot replay as a burst. */
function processNextFromQueue() {
    if (isGenerating || queueResumeTimer || !ws || ws.readyState !== WebSocket.OPEN) return;
    const wait = Math.max(0, RESUME_QUEUE_INTERVAL_MS - (Date.now() - lastQueueProcessAt));
    if (wait > 0) {
        queueResumeTimer = setTimeout(() => {
            queueResumeTimer = null;
            processNextFromQueue();
        }, wait);
        return;
    }
    const next = messageQueue.shift();
    if (!next) return;
    lastQueueProcessAt = Date.now();
    console.log(`[Telegram Bridge] 处理队列消息，剩余队列长度: ${messageQueue.length}`);
    processMessage(next);
}

/**
 * 缓冲模式：把玩家消息加入缓冲区
 */
function addToBuffer(item) {
    if (!buffer || buffer.chatId !== item.chatId) {
        // 已有其他群组的缓冲，先冲刷
        if (buffer) flushBuffer();
        buffer = { chatId: item.chatId, parts: [], timer: null };
    }
    const prefixed = item.isGroup ? applyUserPrefix(item) : item.text;
    buffer.parts.push(prefixed);
    buffer.lastActivity = Date.now();
    console.log(`[Telegram Bridge] 缓冲消息 (${buffer.parts.length}/${getSettings().bufferMaxMessages})，来自: ${item.username || '未知用户'}`);

    // 达到最大条数，立即触发
    if (buffer.parts.length >= getSettings().bufferMaxMessages) {
        flushBuffer();
        return;
    }
    // 重置窗口定时器
    if (buffer.timer) clearTimeout(buffer.timer);
    const pendingBuffer = buffer;
    pendingBuffer.timer = setTimeout(() => {
        if (buffer === pendingBuffer) flushBuffer(pendingBuffer);
    }, (getSettings().bufferWindowSeconds || 30) * 1000);
}

/**
 * 冲刷缓冲区：把收集到的多条玩家消息合并为一条发送给 AI
 */
function flushBuffer(expectedBuffer = null) {
    if (!buffer || (expectedBuffer && buffer !== expectedBuffer)) return;
    const b = buffer;
    buffer = null;
    if (b.timer) clearTimeout(b.timer);
    const text = b.parts.join('\n');
    console.log(`[Telegram Bridge] 冲刷缓冲区 (${b.parts.length} 条消息) → 发送给 AI`);
    enqueueOrProcess({ chatId: b.chatId, text, username: null, isGroup: false });
}

// --- 防连发合并（即时模式） ---
// 玩家连续发送多条短消息时，在合并窗口内攒成一条再触发 AI 回复，更接近真实聊天
let mergeBuffer = null; // { chatId, parts: [item], timer }

function addToMergeBuffer(item, windowSeconds) {
    if (!mergeBuffer || mergeBuffer.chatId !== item.chatId) {
        if (mergeBuffer) flushMergeBuffer();
        mergeBuffer = { chatId: item.chatId, parts: [], timer: null };
    }
    mergeBuffer.parts.push(item);
    if (mergeBuffer.timer) clearTimeout(mergeBuffer.timer);
    const pendingMergeBuffer = mergeBuffer;
    pendingMergeBuffer.timer = setTimeout(() => {
        if (mergeBuffer === pendingMergeBuffer) flushMergeBuffer(pendingMergeBuffer);
    }, windowSeconds * 1000);
    console.log(`[Telegram Bridge] 消息进入合并窗口 (${mergeBuffer.parts.length} 条)，${windowSeconds} 秒后触发`);
}

function flushMergeBuffer(expectedBuffer = null) {
    if (!mergeBuffer || (expectedBuffer && mergeBuffer !== expectedBuffer)) return;
    const b = mergeBuffer;
    mergeBuffer = null;
    if (b.timer) clearTimeout(b.timer);

    const settings = getSettings();
    const lines = b.parts.map(p => {
        if (p.isGroup && settings.multiplayerEnabled && p.username) {
            return applyUserPrefix(p);
        }
        return p.text;
    });
    console.log(`[Telegram Bridge] 合并窗口到期 (${lines.length} 条) → 触发一次回复`);
    enqueueOrProcess({ chatId: b.chatId, text: lines.join('\n'), username: null, isGroup: false });
}

/**
 * 实际处理一条（或一批）玩家消息：注入 ST 并触发生成
 * @param {object} item - { chatId, text, username, isGroup }
 */
async function processMessage(item) {

    // 标记开始生成（先置位，防止 ensure 异步期间的并发）

    isGenerating = true;



    // 0. 确保该 TG 聊天处于独立的酒馆上下文（角色 + 聊天记录），防止多群/私聊串上下文

    if (getSettings().perChatContext) {

        const ready = await ensureChatBinding(item.chatId);

        if (!ready) {

            isGenerating = false;

            if (ws && ws.readyState === WebSocket.OPEN) {

                ws.send(JSON.stringify({ type: 'error_message', chatId: item.chatId, text: '切换到独立聊天上下文失败，请稍后重试。' }));

            }

            setTimeout(processNextFromQueue, 200);

            return;

        }

    }



    const { eventSource, event_types, generate } = SillyTavern.getContext();



    // 切换聊天可能触发 CHAT_CHANGED 重置了标志，这里重新置位

    isGenerating = true;

    lastProcessedChatId = item.chatId;

    // 1. 立即向Telegram发送"输入中"状态
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'typing_action', chatId: item.chatId }));
    }

    // 2. 将用户消息添加到SillyTavern
    //    - 群组 + Multiplayer：添加玩家名前缀（AI 能区分谁说的）
    //    - 私聊：传 name 参数标识消息来源，不再裸注入成"酒馆终端用户"
    //    - 缓冲/合并冲刷出的消息（username=null）保持原样
    let messageText = item.text;
    let messageAuthorName = null;
    if (item.isGroup) {
        if (item.username && getSettings().multiplayerEnabled) {
            messageText = applyUserPrefix(item);
        }
    } else if (item.username && item.username !== 'null' && item.username !== 'undefined') {
        messageAuthorName = item.username;
    }
    // Convert Telegram's static sticker preview into SillyTavern's normal file
    // attachment input. sendMessageAsUser() then uploads it through ST's own
    // /api/images/upload flow and stores extra.media on the chat message.
    if (item.sticker?.imageDataUrl) {
        try {
            const input = document.getElementById('file_form_input');
            if (input instanceof HTMLInputElement) {
                const response = await fetch(item.sticker.imageDataUrl);
                const blob = await response.blob();
                const file = new File([blob], `telegram-sticker-${item.sticker.fileUniqueId || item.sticker.fileId || Date.now()}.webp`, { type: blob.type || 'image/webp' });
                const transfer = new DataTransfer();
                for (const pending of input.files || []) transfer.items.add(pending);
                transfer.items.add(file);
                input.files = transfer.files;
            }
        } catch (error) {
            console.error('[Telegram Bridge] 无法准备贴纸图片附件:', error);
        }
    }

    try {
        await sendMessageAsUser(messageText, null, null, false, messageAuthorName);
    } catch (err) {
        console.error('[Telegram Bridge] sendMessageAsUser() 错误:', err);
        isGenerating = false;
        lastProcessedChatId = null;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error_message',
                chatId: item.chatId,
                text: `抱歉，消息注入失败: ${err.message || '未知错误'}`,
            }));
        }
        setTimeout(processNextFromQueue, 200);
        return;
    }

    // 3. 设置流式传输的回调
    // Do not forward generation chunks. SillyTavern exposes the authoritative
    // is_system marker only on the completed chat message, so streaming text
    // could reach Telegram before that message is classified.
    const streamCallback = (...args) => {
        // Keep extracting the cumulative value locally for diagnostics only.
        const cumulativeText = typeof args[0] === 'string'
            ? args[0]
            : (typeof args[0]?.text === 'string' ? args[0].text
                : (typeof args[0]?.message === 'string' ? args[0].message : ''));
        if (cumulativeText) {
            console.debug('[Telegram Bridge] Generation chunk held until final message classification.');
        }
    };
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

    // 4. 清理函数：生成结束（成功/失败/手动停止）后执行。
    // 最终文本在 GENERATION_ENDED/STOPPED 后按 is_system 判定再发送；不发送流式结束消息。
    const cleanup = () => {
        eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
    };

    // 5. 监听生成结束事件（once，避免干扰后续消息）
    //    注意：Generate 报错时 GENERATION_ENDED 也会触发，且 catch 分支也会走到这里，
    //    因此用 nextScheduled 标志保证队列只被调度一次，避免并发处理两条消息。
    let nextScheduled = false;
    const scheduleNextOnce = () => {
        if (nextScheduled) return;
        nextScheduled = true;
        isGenerating = false;
        lastProcessedChatId = null;
        // 等 handleFinalMessage 的 DOM 提取完成（约100ms）后再处理下一条
        setTimeout(processNextFromQueue, 250);
    };
    const scheduleNext = () => {
        cleanup();
        scheduleNextOnce();
    };
    eventSource.once(event_types.GENERATION_ENDED, scheduleNext);
    eventSource.once(event_types.GENERATION_STOPPED, scheduleNext);

    // 6. 触发生成
    try {
        const abortController = new AbortController();
        setExternalAbortController(abortController);
        await generate('normal', { signal: abortController.signal });
    } catch (error) {
        console.error("[Telegram Bridge] generate() 错误:", error);
        item.error = true;

        // a. 从聊天记录中删除导致错误的用户消息
        try {
            const { deleteLastMessage } = SillyTavern.getContext();
            await deleteLastMessage();
            console.log('[Telegram Bridge] 已删除导致错误的用户消息。');
        } catch (delErr) {
            console.error('[Telegram Bridge] 删除消息失败:', delErr);
        }

        // b. 发送错误信息
        const errorMessage = `抱歉，AI生成回复时遇到错误。\n您的上一条消息已被撤回，请重试或发送不同内容。\n\n错误详情: ${error.message || '未知错误'}`;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error_message',
                chatId: item.chatId,
                text: errorMessage,
            }));
        }

        // 清理并调度下一条（nextScheduled 保证只调度一次）
        scheduleNext();
    }
}

// --- WebSocket 连接 ---

/**
 * 探测 Server 插件状态（启动器模式，用于自动发现独立版服务器端口）
 * @returns {Promise<object|null>} { running, wssPort, configured, ... } 或 null（插件未安装）
 */
async function discoverEmbeddedServer() {
    try {
        const response = await fetch('/api/plugins/telegram-bridge/status', { cache: 'no-store' });
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.warn('[Telegram Bridge] Server 探测失败:', error);
        return null;
    }
}

async function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('[Telegram Bridge] 已连接');
        return;
    }
    const settings = getSettings();
    let url = settings.bridgeUrl;

    // bridgeUrl 留空 → 自动探测 Server（酒馆 Server 插件启动的独立版），自动获取端口
    if (!url) {
        updateStatus('自动探测 Server...', 'orange');
        const embedded = await discoverEmbeddedServer();
        if (embedded && embedded.running && embedded.wssPort) {
            const host = window.location.hostname || '127.0.0.1';
            url = `ws://${host}:${embedded.wssPort}`;
            console.log(`[Telegram Bridge] 自动发现 Server，端口 ${embedded.wssPort}`);
        } else {
            const reason = embedded ? (embedded.configured ? '未运行' : '未配置 Token') : '插件未安装';
            console.error(`[Telegram Bridge] Server 不可用: ${reason}`);
            updateStatus(`Server 不可用（${reason}），请在设置面板启动`, 'red');
            return;
        }
    }

    if (!url) {
        updateStatus('URL 未设置！', 'red');
        return;
    }

    updateStatus('连接中...', 'orange');
    console.log(`[Telegram Bridge] 正在连接 ${url}...`);

    ws = new WebSocket(url);

    const connection = ws;
    connection.onopen = () => {
        if (ws !== connection) return;
        console.log('[Telegram Bridge] 连接成功！');
        updateStatus('已连接', 'green');
        resetReconnectState();
        resetHeartbeatTimeout();
        compactPendingMessages();
        processNextFromQueue();
    };

    connection.onmessage = async (event) => {
        if (ws !== connection) return;
        let data;
        try {
            data = JSON.parse(event.data);

            // --- 心跳消息处理 ---
            if (data.type === 'heartbeat') {
                handleHeartbeat(data);
                return;
            }

            // --- 用户消息处理 ---
            if (data.type === 'user_message') {
                console.log('[Telegram Bridge] 收到用户消息。', data);

                const item = {
                    chatId: data.chatId,
                    text: data.text,
                    username: data.username || null,
                    firstName: data.firstName || null,
                    isGroup: data.isGroup === true,
                    mentioned: data.mentioned === true,
                    sticker: data.sticker || null,
                };
                if (item.sticker) {
                    const kind = item.sticker.isVideo ? '视频贴纸' : item.sticker.isAnimated ? '动画贴纸' : '静态贴纸';
                    const details = [`${kind}`, item.sticker.emoji, item.sticker.setName ? `贴纸包 ${item.sticker.setName}` : null, `file_id ${item.sticker.fileId}`].filter(Boolean).join('，');
                    item.text = `${item.text}\n[${details}]`;
                }

                const settings = getSettings();

                // 提及本 bot：立即触发回复，跳过合并/缓冲窗口，不让对方干等
                if (item.mentioned) {
                    console.log('[Telegram Bridge] 消息提及本 bot，立即触发回复');
                    // 已有同聊天的合并/缓冲内容：并入并立即冲刷，合并成一次回复
                    if (mergeBuffer && mergeBuffer.chatId === item.chatId) {
                        mergeBuffer.parts.push(item);
                        flushMergeBuffer();
                        return;
                    }
                    if (buffer && buffer.chatId === item.chatId) {
                        buffer.parts.push(item.isGroup ? applyUserPrefix(item) : item.text);
                        flushBuffer();
                        return;
                    }
                    enqueueOrProcess(item);
                    return;
                }

                // 缓冲模式：群组多人消息先进缓冲区（大窗口合并）
                if (settings.multiplayerEnabled && settings.defaultMode === 'buffered' && item.isGroup) {
                    addToBuffer(item);
                    return;
                }

                // 即时模式防连发：合并窗口内同一聊天的连续消息攒成一条（更接近真实聊天）
                const mergeWindow = settings.mergeWindowSeconds || 0;
                if (mergeWindow > 0) {
                    addToMergeBuffer(item, mergeWindow);
                    return;
                }

                // 无合并：入队或直接处理
                enqueueOrProcess(item);
                return;
            }

            // --- 系统命令处理 ---
            if (data.type === 'system_command') {
                console.log('[Telegram Bridge] 收到系统命令', data);
                if (data.command === 'reload_ui_only') {
                    console.log('[Telegram Bridge] 正在刷新UI...');
                    setTimeout(reloadPage, 500);
                }
                return;
            }

            // --- 执行命令处理 ---
            if (data.type === 'execute_command') {
                console.log('[Telegram Bridge] 执行命令', data);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                let replyText = '命令执行失败，请稍后重试。';

                // 直接调用全局的 SillyTavern.getContext()
                const context = SillyTavern.getContext();
                let commandSuccess = false;

                const sendChatSelectionForCharacter = async (characterId, introText = '', pageArgRaw = null) => {
                    if (characterId === undefined || characterId === null) {
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: '请先选择一个角色。' }));
                        }
                        return true;
                    }

                    const chatFiles = await getPastCharacterChats(characterId);
                    const CHAT_PAGE_SIZE = 10;
                    const chatPageArg = pageArgRaw ? parseInt(pageArgRaw) : 1;
                    const chatPage = isNaN(chatPageArg) ? 1 : chatPageArg;
                    const chatTotalPages = Math.max(1, Math.ceil(chatFiles.length / CHAT_PAGE_SIZE));
                    const chatCurrentPage = Math.max(1, Math.min(chatPage, chatTotalPages));
                    const chatStartIndex = (chatCurrentPage - 1) * CHAT_PAGE_SIZE;
                    const chatEndIndex = Math.min(chatStartIndex + CHAT_PAGE_SIZE, chatFiles.length);
                    const pageChats = chatFiles.slice(chatStartIndex, chatEndIndex);

                    let chatReplyText = introText ? `${introText}\n\n` : '';
                    const chatButtons = [[{ text: '🆕 新建聊天', callback_data: 'cmd_new' }]];

                    if (chatFiles.length > 0) {
                        chatReplyText += `💬 聊天 (${chatCurrentPage}/${chatTotalPages}页)\n`;
                        pageChats.forEach((chat, index) => {
                            const globalIndex = chatStartIndex + index + 1;
                            let chatName = chat.file_name.replace('.jsonl', '');
                            chatName = chatName.length > 20 ? chatName.substring(0, 20) + '..' : chatName;
                            chatReplyText += `${globalIndex}. ${chatName}\n`;
                        });
                        chatReplyText += `\n选择已有聊天，或点击“新建聊天”。`;

                        pageChats.forEach((chat, index) => {
                            const globalIndex = chatStartIndex + index + 1;
                            const chatName = chat.file_name.replace('.jsonl', '');
                            const label = `${globalIndex}. ${chatName}`.slice(0, 60);
                            chatButtons.push([{ text: label, callback_data: `cmd_switchchat_${globalIndex}` }]);
                        });
                    } else {
                        chatReplyText += '当前角色没有任何聊天记录。可点击“新建聊天”开始。';
                    }

                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'ai_reply',
                            chatId: data.chatId,
                            text: chatReplyText,
                            reply_markup: {
                                inline_keyboard: chatButtons
                            },
                            pagination: {
                                currentPage: chatCurrentPage,
                                totalPages: chatTotalPages,
                                type: 'listchats'
                            }
                        }));
                    }
                    return true;
                };

                try {
                    if (await handleBridgeControlCommand(data, context)) {
                        return;
                    }

                    switch (data.command) {
                        case 'new':

                            await doNewChat({ deleteCurrentChat: false });

                            getOrCreateBinding(data.chatId).chatName = context.getCurrentChatId(); // 绑定到该 TG 聊天

                            replyText = '新的聊天已经开始。';

                            commandSuccess = true;

                            break;
                        case 'listchars': {
                            const characters = context.characters.slice(1);
                            if (characters.length > 0) {
                                // 分页参数：每页显示10个角色（避免消息过长）
                                const PAGE_SIZE = 10;
                                const pageArg = data.args && data.args[0] ? parseInt(data.args[0]) : 1;
                                const page = isNaN(pageArg) ? 1 : pageArg;
                                const totalPages = Math.ceil(characters.length / PAGE_SIZE);
                                const currentPage = Math.max(1, Math.min(page, totalPages));
                                const startIndex = (currentPage - 1) * PAGE_SIZE;
                                const endIndex = Math.min(startIndex + PAGE_SIZE, characters.length);
                                const pageChars = characters.slice(startIndex, endIndex);

                                replyText = `📋 角色 (${currentPage}/${totalPages}页)\n`;
                                pageChars.forEach((char, index) => {
                                    const globalIndex = startIndex + index + 1;
                                    // 截断过长的角色名
                                    const charName = char.name.length > 20 ? char.name.substring(0, 20) + '..' : char.name;
                                    replyText += `${globalIndex}. ${charName}\n`;
                                });
                                replyText += `\n切换: /switchchar_数字`;

                                const charButtons = pageChars.map((char, index) => {
                                    const globalIndex = startIndex + index + 1;
                                    const label = `${globalIndex}. ${char.name}`.slice(0, 60);
                                    return [{ text: label, callback_data: `cmd_switchchar_${globalIndex}` }];
                                });

                                // 发送带分页和切换按钮的回复
                                if (ws && ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({
                                        type: 'ai_reply',
                                        chatId: data.chatId,
                                        text: replyText,
                                        reply_markup: {
                                            inline_keyboard: charButtons
                                        },
                                        pagination: {
                                            currentPage,
                                            totalPages,
                                            type: 'listchars'
                                        }
                                    }));
                                }
                                return;
                            } else {
                                replyText = '没有找到可用角色。';
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchar': {
                            if (!data.args || data.args.length === 0) {
                                replyText = '请提供角色名称或序号。用法: /switchchar <角色名称> 或 /switchchar_数字';
                                break;
                            }
                            const targetName = data.args.join(' ');
                            const characters = context.characters;
                            const targetChar = characters.find(c => c.name === targetName);

                            if (targetChar) {

                                const charIndex = characters.indexOf(targetChar);

                                await context.selectCharacterById(charIndex);

                                getOrCreateBinding(data.chatId).characterId = charIndex; // 绑定到该 TG 聊天

                                commandSuccess = true;

                                await sendChatSelectionForCharacter(charIndex, `已成功切换到角色 "${targetName}"。

请选择聊天记录，或新建聊天：`);

                                return;
                            } else {
                                replyText = `角色 "${targetName}" 未找到。`;
                            }
                            break;
                        }
                        case 'listchats': {
                            if (context.characterId === undefined) {
                                replyText = '请先选择一个角色。';
                                break;
                            }
                            const chatPageArg = data.args && data.args[0] ? data.args[0] : 1;
                            await sendChatSelectionForCharacter(context.characterId, '', chatPageArg);
                            return;
                        }
                        case 'switchchat': {
                            if (!data.args || data.args.length === 0) {
                                replyText = '请提供聊天记录名称。用法： /switchchat <聊天记录名称>';
                                break;
                            }
                            const targetChatFile = `${data.args.join(' ')}`;

                            try {

                                await context.openCharacterChat(targetChatFile);

                                getOrCreateBinding(data.chatId).chatName = targetChatFile.replace(/\.jsonl$/, ''); // 绑定到该 TG 聊天

                                replyText = `已加载聊天记录： ${targetChatFile}`;

                                commandSuccess = true;
                            } catch (err) {
                                console.error(err);
                                replyText = `加载聊天记录 "${targetChatFile}" 失败。请确认名称完全正确。`;
                            }
                            break;
                        }
                        default: {
                            // 处理特殊格式的命令，如 switchchar_1, switchchat_2 等
                            const charMatch = data.command.match(/^switchchar_(\d+)$/);
                            if (charMatch) {
                                const index = parseInt(charMatch[1]) - 1;
                                const characters = context.characters.slice(1);
                                if (index >= 0 && index < characters.length) {

                                    const targetChar = characters[index];

                                    const charIndex = context.characters.indexOf(targetChar);

                                    await context.selectCharacterById(charIndex);

                                    getOrCreateBinding(data.chatId).characterId = charIndex; // 绑定到该 TG 聊天

                                    commandSuccess = true;

                                    await sendChatSelectionForCharacter(charIndex, `已切换到角色 "${targetChar.name}"。

请选择聊天记录，或新建聊天：`);

                                    return;
                                } else {
                                    replyText = `无效的角色序号: ${index + 1}。请使用 /listchars 查看可用角色。`;
                                }
                                break;
                            }

                            const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                            if (chatMatch) {
                                if (context.characterId === undefined) {
                                    replyText = '请先选择一个角色。';
                                    break;
                                }
                                const index = parseInt(chatMatch[1]) - 1;
                                const chatFiles = await getPastCharacterChats(context.characterId);

                                if (index >= 0 && index < chatFiles.length) {
                                    const targetChat = chatFiles[index];
                                    const chatName = targetChat.file_name.replace('.jsonl', '');
                                    try {

                                        await context.openCharacterChat(chatName);

                                        getOrCreateBinding(data.chatId).chatName = chatName; // 绑定到该 TG 聊天

                                        replyText = `已加载聊天记录： ${chatName}`;

                                        commandSuccess = true;

                                    } catch (err) {

                                        console.error(err);

                                        replyText = `加载聊天记录失败。`;

                                    }
                                } else {
                                    replyText = `无效的聊天记录序号: ${index + 1}。请使用 /listchats 查看可用聊天记录。`;
                                }
                                break;
                            }

                            // 未知命令：静默忽略，不回复（避免群聊噪音）
                            replyText = null;
                        }
                    }
                } catch (error) {
                    console.error('[Telegram Bridge] 执行命令时出错:', error);
                    replyText = `执行命令时出错: ${error.message || '未知错误'}`;
                }

                // 发送命令执行结果
                if (ws && ws.readyState === WebSocket.OPEN) {
                    // 未知命令（replyText 为 null）不回 ai_reply，仅记录执行状态
                    if (replyText) {
                        ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: replyText }));
                    }
                    // 发送命令执行状态反馈到服务器
                    ws.send(JSON.stringify({
                        type: 'command_executed',
                        command: data.command,
                        success: commandSuccess,
                        message: replyText || ''
                    }));
                }

                return;
            }
        } catch (error) {
            console.error('[Telegram Bridge] 处理请求时发生错误：', error);
            if (data && data.chatId && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error_message', chatId: data.chatId, text: '处理您的请求时发生了一个内部错误。' }));
            }
        }
    };

    connection.onclose = () => {
        console.log('[Telegram Bridge] 连接已关闭。');
        if (ws !== connection) return;
        clearHeartbeatTimeout();
        ws = null;
        if (buffer) {
            if (buffer.timer) clearTimeout(buffer.timer);
            deferPendingBuffer(buffer);
            buffer = null;
        }
        if (mergeBuffer) {
            if (mergeBuffer.timer) clearTimeout(mergeBuffer.timer);
            deferPendingBuffer(mergeBuffer);
            mergeBuffer = null;
        }
        compactPendingMessages();
        const settings = getSettings();
        if (settings.autoConnect && !isReconnecting) {
            updateStatus('连接已断开，准备重连...', 'orange');
            attemptReconnect();
        } else {
            updateStatus('连接已断开', 'red');
        }
    };

    connection.onerror = (error) => {
        console.error('[Telegram Bridge] WebSocket 错误：', error);
        if (ws !== connection) return;
        clearHeartbeatTimeout();
        updateStatus('连接错误', 'red');
    };
}

function disconnect() {
    cancelReconnect();
    if (ws) {
        ws.close();
    }
}

// --- DOM 文本提取（用于获取最终渲染后的消息） ---

function extractTextFromDOM(messageTextElement) {
    const clone = messageTextElement.clone();
    clone.find('br').replaceWith('\n');
    clone.find('p').each(function () {
        $(this).prepend('\n\n').append('\n\n');
    });
    clone.find('div').each(function () {
        $(this).append('\n');
    });
    clone.find('b, strong').each(function () {
        const text = $(this).text();
        $(this).replaceWith(`**${text}**`);
    });
    clone.find('i, em').each(function () {
        const text = $(this).text();
        $(this).replaceWith(`*${text}*`);
    });
    clone.find('code').each(function () {
        const text = $(this).text();
        if (text.includes('\n')) {
            $(this).replaceWith(`\`\`\`\n${text}\n\`\`\``);
        } else {
            $(this).replaceWith(`\`${text}\``);
        }
    });
    clone.find('pre').each(function () {
        const text = $(this).text();
        $(this).replaceWith(`\`\`\`\n${text}\n\`\`\``);
    });
    let text = clone.text();
    text = decodeHtmlEntities(text);
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

function decodeHtmlEntities(text) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = text;
    return tempDiv.textContent || tempDiv.innerText || '';
}

// --- 最终消息处理 ---

/**
 * 酒馆本地生成的 AI 回复（非 Telegram 触发）→ 同步推送到最近活跃的 Telegram 聊天
 */
function handleLocalGeneration(lastMessageIdInChatArray) {
    if (!getSettings().syncLocalToTelegram) return;

    let lastMessageIndex;
    if (typeof lastMessageIdInChatArray === 'number' && lastMessageIdInChatArray > 0) {
        lastMessageIndex = lastMessageIdInChatArray - 1;
    } else {
        const currentChat = SillyTavern.getContext().chat;
        lastMessageIndex = Array.isArray(currentChat) ? currentChat.length - 1 : -1;
    }
    if (lastMessageIndex < 0) return;

    setTimeout(() => {
        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];
        if (!lastMessage || lastMessage.is_user || lastMessage.is_system) {
            if (lastMessage?.is_system) console.debug('[Telegram Bridge] Suppressed SillyTavern system message from Telegram sync:', lastMessage.mes);
            return;
        }
        if (typeof lastMessage.mes !== 'string' || !lastMessage.mes.trim()) return;

        console.log('[Telegram Bridge] 酒馆本地生成，同步到 Telegram:', lastMessage.mes.slice(0, 50));
        ws.send(JSON.stringify({ type: 'local_reply', text: lastMessage.mes.trim() }));
    }, 100);
}

function handleFinalMessage(lastMessageIdInChatArray) {
    console.log(`[Telegram Bridge] handleFinalMessage 被调用, lastMessageId: ${lastMessageIdInChatArray}, lastProcessedChatId: ${lastProcessedChatId}`);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    // 非 Telegram 触发的生成（酒馆本地用户操作）→ 双向同步
    if (!lastProcessedChatId) {
        handleLocalGeneration(lastMessageIdInChatArray);
        return;
    }

    // GENERATION_ENDED 传 chat.length；GENERATION_STOPPED 不传参数，回退到 chat 数组
    let lastMessageIndex;
    if (typeof lastMessageIdInChatArray === 'number' && lastMessageIdInChatArray > 0) {
        lastMessageIndex = lastMessageIdInChatArray - 1;
    } else {
        const currentChat = SillyTavern.getContext().chat;
        lastMessageIndex = Array.isArray(currentChat) ? currentChat.length - 1 : -1;
    }
    if (lastMessageIndex < 0) return;

    const chatIdToSend = lastProcessedChatId;

    setTimeout(() => {
        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];

        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            let renderedText = null;

            // 优先从 DOM 提取渲染后的文本（保留格式标记）
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);
            if (messageElement.length > 0) {
                const messageTextElement = messageElement.find('.mes_text');
                if (messageTextElement.length > 0) {
                    renderedText = extractTextFromDOM(messageTextElement);
                }
            }

            // DOM 提取失败时回退到 chat 数组中的原始文本
            if (!renderedText && typeof lastMessage.mes === 'string') {
                console.log('[Telegram Bridge] DOM提取失败，回退到 chat 原始文本');
                renderedText = lastMessage.mes.trim();
            }

            if (renderedText) {
                console.log(`[Telegram Bridge] 捕获到最终文本，发送更新到 chatId: ${chatIdToSend}`);
                ws.send(JSON.stringify({
                    type: 'final_message_update',
                    chatId: chatIdToSend,
                    text: renderedText,
                }));
            }
        } else if (lastMessage?.is_system) {
            console.debug('[Telegram Bridge] Suppressed SillyTavern system message from Telegram delivery:', lastMessage.mes);
        }

        // 重置当前会话标识（不管成功与否）
        if (lastProcessedChatId === chatIdToSend) {
            lastProcessedChatId = null;
        }
    }, 100);
}

// --- 会话清理 ---

function cleanupStreamSession() {
    console.log('[Telegram Bridge] 检测到角色/聊天切换，清理流式会话状态');
    isGenerating = false;
    if (buffer) {
        if (buffer.timer) clearTimeout(buffer.timer);
        buffer = null;
    }
    if (mergeBuffer) {
        if (mergeBuffer.timer) clearTimeout(mergeBuffer.timer);
        mergeBuffer = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN && lastProcessedChatId) {
        ws.send(JSON.stringify({
            type: 'cleanup_session',
            chatId: lastProcessedChatId,
        }));
        console.log(`[Telegram Bridge] 已发送清理消息到 chatId: ${lastProcessedChatId}`);
    }
    lastProcessedChatId = null;
}

// --- 设置界面 ---

async function loadSettingsUI() {
    console.log('[Telegram Bridge] 正在尝试加载设置 UI...');
    const { renderExtensionTemplateAsync } = SillyTavern.getContext();

    // 读取扩展版本（manifest.json），用于面板显示版本徽标 + 缓存穿透参数
    let extVersion = 'unknown';
    try {
        const manifestUrl = new URL('manifest.json', import.meta.url).href;
        const manifestResp = await fetch(manifestUrl, { cache: 'no-store' });
        if (manifestResp.ok) {
            const manifest = await manifestResp.json();
            extVersion = manifest.version || 'unknown';
        }
    } catch (error) {
        console.warn('[Telegram Bridge] 读取 manifest.json 失败:', error);
    }
    console.log(`[Telegram Bridge] 扩展版本: v${extVersion}`);

    // 主路径：直接 fetch settings.html（带 no-store + 版本/时间戳参数，强制绕过缓存，
    // 避免更新文件后浏览器仍加载旧的设置面板）
    let settingsHtml = null;
    try {
        const settingsUrl = new URL('settings.html', import.meta.url).href;
        const response = await fetch(`${settingsUrl}?v=${extVersion}&t=${Date.now()}`, { cache: 'no-store' });
        if (response.ok) {
            settingsHtml = await response.text();
        }
    } catch (error) {
        console.warn('[Telegram Bridge] 直接加载 settings.html 失败:', error);
    }

    // 回退：renderExtensionTemplateAsync（从自身模块 URL 推导扩展文件夹名）
    if (!settingsHtml) {
        try {
            const url = new URL('.', import.meta.url).href;
            const match = url.match(/\/scripts\/extensions\/(.+?)\/$/);
            if (match && renderExtensionTemplateAsync) {
                const folder = match[1];
                console.log(`[Telegram Bridge] 扩展文件夹: ${folder}`);
                settingsHtml = await renderExtensionTemplateAsync(folder, 'settings');
            }
        } catch (error) {
            console.warn('[Telegram Bridge] renderExtensionTemplateAsync 失败:', error);
        }
    }

    if (!settingsHtml) {
        console.error('[Telegram Bridge] 设置面板加载失败（主路径与回退均失败）');
        return;
    }

    // 面板顶部注入版本徽标，一眼可确认运行版本
    const versionBadge = `<div style="font-size:0.85em; opacity:0.55; padding:2px 0 4px;">Telegram MultiPlayer v${extVersion}</div>`;
    settingsHtml = versionBadge + settingsHtml;

    // 官方文档（Writing-Extensions）推荐的扩展设置挂载容器是 #extensions_settings2
    // 兼容回退：#extensions_settings（旧容器，部分 ST 版本/主题可能仍在使用）
    let settingsContainer = $('#extensions_settings2');
    if (settingsContainer.length === 0) {
        settingsContainer = $('#extensions_settings');
    }
    if (settingsContainer.length === 0) {
        console.error('[Telegram Bridge] 找不到扩展设置容器(#extensions_settings2 / #extensions_settings)');
        return;
    }

    settingsContainer.append(settingsHtml);
    console.log(`[Telegram Bridge] 设置 UI 已添加到容器 #${settingsContainer.attr('id')}`);

    bindSettingsUI();

    // 自检：确认 settings.html 文件内容与关键控件是否渲染（用于定位"界面旧/缺选项"问题）
    console.log('[Telegram Bridge] 自检 → settings.html 内容长度:', settingsHtml.length, '(新版约 6.5KB+)');
    console.log('[Telegram Bridge] 自检 → settings.html 含 Multiplayer 控件:', settingsHtml.includes('telegram_multiplayer_enabled'));
    console.log('[Telegram Bridge] 自检 → Multiplayer 选项:', $('#telegram_multiplayer_enabled').length > 0 ? '存在 ✅' : '缺失 ❌');
    console.log('[Telegram Bridge] 自检 → Server启动器区块:', $('#telegram_server_start').length > 0 ? '存在 ✅' : '缺失 ❌');
    console.log('[Telegram Bridge] 自检 → 合并窗口:', $('#telegram_merge_window').length > 0 ? '存在 ✅' : '缺失 ❌');
}

function bindSettingsUI() {
    const settings = getSettings();
    const { saveSettingsDebounced } = SillyTavern.getContext();

    $('#telegram_bridge_url').val(settings.bridgeUrl);
    $('#telegram_auto_connect').prop('checked', settings.autoConnect);
    $('#telegram_multiplayer_enabled').prop('checked', settings.multiplayerEnabled);
    $('#telegram_user_prefix').val(settings.userPrefix);
    $('#telegram_default_mode').val(settings.defaultMode);
    $('#telegram_merge_window').val(settings.mergeWindowSeconds);
    $('#telegram_buffer_window').val(settings.bufferWindowSeconds);
    $('#telegram_buffer_max').val(settings.bufferMaxMessages);
    $('#telegram_sync_local').prop('checked', settings.syncLocalToTelegram);

    $('#telegram_per_chat_context').prop('checked', settings.perChatContext);



    $('#telegram_bridge_url').on('input', () => {
        getSettings().bridgeUrl = $('#telegram_bridge_url').val();
        saveSettingsDebounced();
    });

    $('#telegram_auto_connect').on('change', function () {
        getSettings().autoConnect = $(this).prop('checked');
        console.log(`[Telegram Bridge] 自动连接设置已更改为: ${getSettings().autoConnect}`);
        saveSettingsDebounced();
    });

    $('#telegram_multiplayer_enabled').on('change', function () {
        getSettings().multiplayerEnabled = $(this).prop('checked');
        console.log(`[Telegram Bridge] Multiplayer 模式: ${getSettings().multiplayerEnabled ? '启用' : '关闭'}`);
        // 切换时清空缓冲
        if (buffer) {
            if (buffer.timer) clearTimeout(buffer.timer);
            buffer = null;
        }
        saveSettingsDebounced();
    });

    $('#telegram_user_prefix').on('change', function () {
        getSettings().userPrefix = $(this).val();
        console.log(`[Telegram Bridge] 用户前缀格式: ${getSettings().userPrefix}`);
        saveSettingsDebounced();
    });

    $('#telegram_default_mode').on('change', function () {
        getSettings().defaultMode = $(this).val();
        console.log(`[Telegram Bridge] 默认模式: ${getSettings().defaultMode}`);
        if (buffer) {
            if (buffer.timer) clearTimeout(buffer.timer);
            buffer = null;
        }
        saveSettingsDebounced();
    });

    $('#telegram_buffer_window').on('change', function () {
        const value = parseInt($(this).val());
        getSettings().bufferWindowSeconds = isNaN(value) || value <= 0 ? 30 : value;
        saveSettingsDebounced();
    });

    $('#telegram_buffer_max').on('change', function () {
        const value = parseInt($(this).val());
        getSettings().bufferMaxMessages = isNaN(value) || value <= 0 ? 8 : value;
        saveSettingsDebounced();
    });

    $('#telegram_merge_window').on('change', function () {
        const value = parseInt($(this).val());
        getSettings().mergeWindowSeconds = isNaN(value) || value < 0 ? 3 : value;
        console.log(`[Telegram Bridge] 合并窗口: ${getSettings().mergeWindowSeconds} 秒`);
        saveSettingsDebounced();
    });

    $('#telegram_sync_local').on('change', function () {
        getSettings().syncLocalToTelegram = $(this).prop('checked');
        console.log(`[Telegram Bridge] 双向同步: ${getSettings().syncLocalToTelegram ? '开启' : '关闭'}`);
        saveSettingsDebounced();
    });

    $('#telegram_per_chat_context').on('change', function () {
        getSettings().perChatContext = $(this).prop('checked');
        console.log(`[Telegram Bridge] 独立上下文: ${getSettings().perChatContext ? '开启' : '关闭'}`);
        if (getSettings().perChatContext) chatBindings.clear(); // 重新初始化绑定
        saveSettingsDebounced();
    });

    $('#telegram_connect_button').on('click', connect);
    $('#telegram_disconnect_button').on('click', disconnect);

    // --- Server 管理（酒馆 Server 插件启动器） ---
    bindEmbeddedServerControls();

    if (settings.autoConnect) {
        console.log('[Telegram Bridge] 自动连接已启用，正在连接...');
        connect();
    }
}

/**
 * 刷新 Server 状态显示（启动器模式：running = 独立版 server.js 子进程存活）
 */
async function refreshEmbeddedStatus() {
    const el = document.getElementById('telegram_server_status');
    if (!el) return;
    const embedded = await discoverEmbeddedServer();
    if (!embedded) {
        el.innerHTML = '<span style="color:orange">插件未安装</span>（未检测到 plugins/telegram-bridge）';
        return;
    }
    if (embedded.running) {
        el.innerHTML = `<span style="color:green">● 运行中</span> · WebSocket 端口 <b>${embedded.wssPort}</b>`;
    } else {
        el.innerHTML = `<span style="color:red">○ 未运行</span>（${embedded.configured ? '已配置 Token，可点「🚀 启动 Server」' : '未配置 Token，请先保存'}）`;
    }
}

function bindEmbeddedServerControls() {
    $('#telegram_token_save').on('click', async () => {
        const token = $('#telegram_bot_token').val().trim();
        if (!token) {
            toastr?.warning?.('请输入 Bot Token');
            return;
        }
        const response = await fetch('/api/plugins/telegram-bridge/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telegramToken: token }),
        });
        const result = await response.json();
        console.log('[Telegram Bridge] 保存 Token 结果:', result);
        toastr?.success?.(result.ok ? 'Token 已保存' : `保存失败: ${result.error || ''}`);
        refreshEmbeddedStatus();
    });

    $('#telegram_server_start').on('click', async () => {
        const token = $('#telegram_bot_token').val().trim();
        const response = await fetch('/api/plugins/telegram-bridge/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telegramToken: token }),
        });
        const result = await response.json();
        console.log('[Telegram Bridge] 启动 Server 结果:', result);
        if (result.ok && result.wssPort) {
            toastr?.success?.(`Server 已启动，端口 ${result.wssPort}`);
            // 若 URL 留空（自动模式），直接连接
            if (!getSettings().bridgeUrl) connect();
        } else {
            toastr?.error?.(`启动失败: ${result.error || '未知错误'}`);
        }
        refreshEmbeddedStatus();
    });

    $('#telegram_server_stop').on('click', async () => {
        const response = await fetch('/api/plugins/telegram-bridge/stop', { method: 'POST' });
        const result = await response.json();
        console.log('[Telegram Bridge] 停止 Server 结果:', result);
        toastr?.success?.('Server 已停止');
        if (ws) disconnect();
        refreshEmbeddedStatus();
    });

    $('#telegram_server_refresh').on('click', refreshEmbeddedStatus);

    // 初始刷新状态
    setTimeout(refreshEmbeddedStatus, 300);
}

// --- 生命周期钩子（官方推荐） ---

export function onActivate() {
    console.log('[Telegram Bridge] 扩展激活 (onActivate)');
    const { eventSource, event_types } = SillyTavern.getContext();

    // 全局事件监听器：生成结束后发送最终渲染文本
    eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);
    eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);

    // 角色/聊天切换时清理流式会话状态
    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log('[Telegram Bridge] 检测到聊天切换');
        cleanupStreamSession();
    });

    // APP_READY 后执行异步初始化（加载设置UI、自动连接）
    // 用 setTimeout 延迟，避免阻塞 APP_READY 事件处理器
    // 使用 on + removeListener 而非 once，保证无论 APP_READY 是否已触发过都能执行
    const onAppReady = () => {
        eventSource.removeListener(event_types.APP_READY, onAppReady);
        setTimeout(async () => {
            try {
                await loadSettingsUI();
            } catch (error) {
                console.error('[Telegram Bridge] 加载设置 UI 失败。', error);
            }
            console.log('[Telegram Bridge] 扩展已加载。');
        }, 0);
    };
    eventSource.on(event_types.APP_READY, onAppReady);
}

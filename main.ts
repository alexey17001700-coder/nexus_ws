// =========================================
// NEXUS CHAT — WebSocket relay server
// Отдельный репозиторий nexus_ws.
// Штаб (digital-agency) НЕ ТРОГАЕТ.
// Запуск локально на Vivo.
// Порт: Deno.env.get("PORT") || 8001
// =========================================

const PORT = Number(Deno.env.get("PORT") || 8001);

const MAX_HISTORY = 80;          // сколько последних сообщений храним в комнате
const MAX_MSG_SIZE = 900_000;    // ~900 КБ (фото / файлы / голосовые)
const PING_INTERVAL = 25_000;    // keep-alive пинг
const MAX_ROOMS = 500;

// =========================================
// TELEGRAM-УВЕДОМЛЕНИЯ (необязательный модуль)
// Токен только из переменной окружения TELEGRAM_TOKEN.
// В коде секретов НЕТ.
// Подписка: написать боту /start ТвойНик
// =========================================
const TG_TOKEN = Deno.env.get("TELEGRAM_TOKEN") || "";
const TG_ENABLED = TG_TOKEN.length > 10;
const TG_THROTTLE = 10_000;      // не чаще 1 уведомления на канал в 10 сек
const roomNames = new Map<string, string>();   // id канала → «иконка Название»
const tgSubs = new Map<string, string>();      // chat_id → ник ("" = уведомлять обо всём)
const tgLast = new Map<string, number>();      // канал → время последнего уведомления
const tgPending = new Map<string, number>();   // канал → сколько сообщений накопилось
let tgOffset = 0;

async function tgSend(chatId: string, text: string) {
    if (!TG_ENABLED) return;
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        });
    } catch (_) { /* ignore */ }
}

function tgTitle(room: string) {
    return roomNames.get(room) || "канал";
}

/* уведомить о новом сообщении (ник отправителя — чтобы не слать ему же) */
function tgNotify(room: string, senderNick: string) {
    if (!TG_ENABLED) return;
    if (!room || room === "__dir__") return;
    if (tgSubs.size === 0) return;

    // если отправитель ещё сидит в комнате — он и так всё видит, не шумим
    const r = rooms.get(room);
    if (r && senderNick) {
        for (const c of r) if (c.nick === senderNick) return;
    }

    const now = Date.now();
    const last = tgLast.get(room) || 0;
    if (now - last < TG_THROTTLE) {
        tgPending.set(room, (tgPending.get(room) || 0) + 1);
        return;
    }
    const extra = tgPending.get(room) || 0;
    tgPending.set(room, 0);
    tgLast.set(room, now);

    const text = `💬 Новое сообщение\n📢 ${tgTitle(room)}` + (extra > 0 ? `\n(и ещё ${extra})` : "");
    for (const [chatId, nick] of tgSubs) {
        if (nick && senderNick && nick === senderNick) continue;
        tgSend(chatId, text);
    }
}

/* досылаем накопившееся после «тишины» */
function tgFlush() {
    if (!TG_ENABLED) return;
    const now = Date.now();
    for (const [room, n] of tgPending) {
        if (!n) continue;
        if (now - (tgLast.get(room) || 0) < TG_THROTTLE) continue;
        tgPending.set(room, 0);
        tgLast.set(room, now);
        const text = `💬 Новое сообщение\n📢 ${tgTitle(room)}\n(и ещё ${n})`;
        for (const chatId of tgSubs.keys()) tgSend(chatId, text);
    }
}

/* опрос бота: /start ТвойНик — подписка, /stop — отписка */
async function tgPoll() {
    if (!TG_ENABLED) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?limit=50&offset=${tgOffset}`);
        const data = await res.json();
        if (!data || !data.ok || !Array.isArray(data.result)) return;
        for (const upd of data.result) {
            tgOffset = upd.update_id + 1;
            const m = upd.message || upd.edited_message;
            if (!m || !m.chat) continue;
            const chatId = String(m.chat.id);
            const txt = String(m.text || "").trim();

            if (txt.startsWith("/stop")) {
                tgSubs.delete(chatId);
                tgSend(chatId, "🔕 Уведомления выключены. Вернуть: /start ТвойНик");
                continue;
            }
            if (txt.startsWith("/status")) {
                tgSend(chatId, tgSubs.has(chatId)
                    ? `✅ Подписка активна. Ник: ${tgSubs.get(chatId) || "любой"}`
                    : "❌ Подписки нет. Включить: /start ТвойНик");
                continue;
            }
            const nick = txt.replace(/^\/(start|subscribe)\s*/, "").trim().slice(0, 40);
            tgSubs.set(chatId, nick);
            tgSend(chatId, nick
                ? `✅ Уведомления включены.\nНик: ${nick}\nБуду писать при новых сообщениях в каналах.`
                : "✅ Уведомления включены.\n\nЧтобы не получать свои же сообщения, напиши:\n/start ТвойНик");
        }
    } catch (_) { /* ignore */ }
}

/* чат из переменной окружения — подписка, которая живёт после перезапуска */
{
    const envChat = Deno.env.get("TELEGRAM_CHAT_ID") || "";
    if (TG_ENABLED && envChat) tgSubs.set(envChat, Deno.env.get("TELEGRAM_NICK") || "");
}

type Client = {
    socket: WebSocket;
    room: string;
    id: string;
    nick: string;
    alive: boolean;
};

const rooms = new Map<string, Set<Client>>();
const history = new Map<string, string[]>();
const allClients = new Set<Client>();

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

function getRoom(name: string): Set<Client> {
    let r = rooms.get(name);
    if (!r) {
        if (rooms.size >= MAX_ROOMS) {
            // чистим пустые комнаты, чтобы не росло бесконечно
            for (const [k, v] of rooms) if (v.size === 0) { rooms.delete(k); history.delete(k); }
        }
        r = new Set();
        rooms.set(name, r);
    }
    return r;
}

function send(client: Client, obj: any) {
    try {
        if (client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify(obj));
        }
    } catch (_) { /* ignore */ }
}

function broadcast(room: string, obj: any, except?: Client) {
    const r = rooms.get(room);
    if (!r || r.size === 0) return;
    const payload = JSON.stringify(obj);
    for (const c of r) {
        if (c === except) continue;
        try {
            if (c.socket.readyState === WebSocket.OPEN) c.socket.send(payload);
        } catch (_) { /* ignore */ }
    }
}

function pushHistory(room: string, raw: string) {
    let h = history.get(room);
    if (!h) { h = []; history.set(room, h); }
    h.push(raw);
    if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}

/* список участников комнаты — для индикатора «кто в сети» */
function usersOf(room: string) {
    const r = rooms.get(room);
    if (!r) return [];
    const out: any[] = [];
    for (const c of r) out.push({ id: c.id, nick: c.nick || "Гость" });
    return out;
}

function leaveRoom(client: Client) {
    const r = rooms.get(client.room);
    if (!r) return;
    r.delete(client);
    broadcast(client.room, { t: "presence", room: client.room, count: r.size, users: usersOf(client.room) });
}

function joinRoom(client: Client, room: string) {
    if (client.room === room) return;
    leaveRoom(client);
    client.room = room;
    const r = getRoom(room);
    r.add(client);

    // отдаём историю комнаты
    const h = history.get(room) || [];
    const items: any[] = [];
    for (const raw of h) {
        try { items.push(JSON.parse(raw)); } catch (_) { /* skip */ }
    }
    send(client, { t: "history", room, items });
    send(client, { t: "welcome", room, id: client.id, count: r.size, users: usersOf(room) });
    broadcast(room, { t: "presence", room, count: r.size, users: usersOf(room) }, client);
}

function handleMessage(client: Client, raw: string) {
    if (raw.length > MAX_MSG_SIZE) {
        send(client, { t: "error", error: "Сообщение слишком большое" });
        return;
    }

    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    // --- служебные ---
    if (msg.t === "ping") { send(client, { t: "pong", ts: Date.now() }); return; }

    if (msg.t === "join") {
        const room = String(msg.room || "").slice(0, 120);
        if (!room) return;
        if (msg.id) client.id = String(msg.id).slice(0, 80);
        if (msg.nick) client.nick = String(msg.nick).slice(0, 40);
        joinRoom(client, room);
        return;
    }

    /* «кто в сети» — клиент может спросить список участников в любой момент */
    if (msg.t === "who") {
        const room = String(msg.room || client.room || "").slice(0, 120);
        if (!room) return;
        const r = rooms.get(room);
        send(client, { t: "presence", room, count: r ? r.size : 0, users: usersOf(room) });
        return;
    }

    if (msg.t === "leave") { leaveRoom(client); client.room = ""; return; }

    if (msg.t === "typing") {
        if (!client.room) return;
        broadcast(client.room, { t: "typing", room: client.room, nick: String(msg.nick || "").slice(0, 40) }, client);
        return;
    }

    // --- основное: сообщение в комнату ---
    if (msg.t === "msg") {
        const room = String(msg.room || client.room || "").slice(0, 120);
        if (!room || !msg.d) return;
        if (client.room !== room) joinRoom(client, room);

        const envelope = { t: "msg", room, d: msg.d, ts: Date.now() };
        const packed = JSON.stringify(envelope);

        // в истории держим только «постоянные» сообщения (без typing/служебных)
        if (msg.d && msg.d.kind !== "typing") pushHistory(room, packed);

        broadcast(room, envelope);
        return;
    }

    // --- синхронизация справочника каналов (замена MQTT/ntfy) ---
    if (msg.t === "dir") {
        const room = "__dir__";
        if (client.room !== room) joinRoom(client, room);
        // запоминаем названия каналов — нужны для текста уведомлений
        try {
            const list = Array.isArray(msg.d) ? msg.d : [];
            for (const c of list) {
                if (!c || !c.id) continue;
                const id = String(c.id);
                if (c.del) { roomNames.delete(id); continue; }
                roomNames.set(id, `${c.icon ? c.icon + " " : ""}${c.name || "канал"}`);
            }
        } catch (_) { /* ignore */ }
        const envelope = { t: "dir", room, d: msg.d, ts: Date.now() };
        pushHistory(room, JSON.stringify(envelope));
        broadcast(room, envelope);
        return;
    }
}

// =========================================
// СЕРВЕР
// =========================================
Deno.serve({ port: PORT }, (request) => {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // --- WebSocket ---
    const upgrade = (request.headers.get("upgrade") || "").toLowerCase();
    if (upgrade === "websocket") {
        const { socket, response } = Deno.upgradeWebSocket(request);

        const client: Client = {
            socket,
            room: "",
            id: crypto.randomUUID().slice(0, 8),
            nick: "",
            alive: true,
        };

        socket.onopen = () => {
            allClients.add(client);
            send(client, { t: "hello", id: client.id, server: "nexus-ws", ts: Date.now() });
        };

        socket.onmessage = (e) => {
            client.alive = true;
            try { handleMessage(client, String(e.data)); } catch (_) { /* ignore */ }
        };

        socket.onclose = () => {
            leaveRoom(client);
            allClients.delete(client);
        };

        socket.onerror = () => {
            try { socket.close(); } catch (_) { /* ignore */ }
        };

        return response;
    }

    // --- health / stats ---
    if (url.pathname === "/stats" || url.pathname === "/") {
        const roomStats: any = {};
        for (const [name, set] of rooms) roomStats[name] = set.size;
        return json({
            ok: true,
            server: "nexus-ws",
            port: PORT,
            clients: allClients.size,
            rooms: rooms.size,
            history: history.size,
            roomStats,
            ts: Date.now(),
        });
    }

    return json({ ok: false, error: "Not found" }, 404);
});

console.log(`[nexus-ws] WebSocket relay запущен на порту ${PORT}`);

// =========================================
// KEEP-ALIVE: чистим мёртвые соединения
// =========================================
setInterval(() => {
    for (const c of allClients) {
        if (!c.alive) {
            try { c.socket.close(); } catch (_) { /* ignore */ }
            leaveRoom(c);
            allClients.delete(c);
            continue;
        }
        c.alive = false;
        try {
            if (c.socket.readyState === WebSocket.OPEN) c.socket.send(JSON.stringify({ t: "ping", ts: Date.now() }));
        } catch (_) { /* ignore */ }
    }
}, PING_INTERVAL);

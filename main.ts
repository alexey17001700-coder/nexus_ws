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
// WEB PUSH — уведомления браузера (необязательный модуль)
// VAPID-ключи ТОЛЬКО из переменных окружения. В коде секретов НЕТ.
//   VAPID_PUBLIC   — публичный ключ (отдаётся клиенту, не секрет)
//   VAPID_PRIVATE  — приватный ключ (НИКОГДА не публиковать)
//   VAPID_SUBJECT  — mailto:твоя@почта  или  https://твой-домен
// Ключей нет → push выключен, сервер работает как обычно.
// =========================================
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC") || "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE") || "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
const PUSH_THROTTLE = 5_000;   // не чаще 1 уведомления на канал в 5 сек

let webpush: any = null;
let PUSH_ENABLED = false;

/* библиотека web-push тянется динамически: если её нет — сервер всё равно работает */
async function initPush() {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
        console.log("[nexus-ws] Web Push: ВЫКЛ (нет VAPID_PUBLIC / VAPID_PRIVATE)");
        return;
    }
    try {
        const mod: any = await import("npm:web-push@3.6.7");
        webpush = mod.default || mod;
        webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
        PUSH_ENABLED = true;
        console.log("[nexus-ws] Web Push: ВКЛ");
    } catch (e) {
        console.log("[nexus-ws] Web Push: библиотека недоступна — " + e);
    }
}
initPush();

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

// =========================================
// WEB PUSH — хранение подписок и отправка
// =========================================
type PushRec = { sub: any; nick: string; rooms: Set<string>; at: number };
const pushSubs = new Map<string, PushRec>();   // endpoint → подписка
const pushLast = new Map<string, number>();    // канал → время последнего уведомления
const pushPending = new Map<string, number>(); // канал → сколько сообщений накопилось

/* --- подписки сохраняем на диск: иначе после рестарта сервера
       уведомления молча отваливаются и человек их больше не получает --- */
const PUSH_FILE = new URL("./push_subs.json", import.meta.url).pathname;
let pushDirty = false;

function pushPersist() { pushDirty = true; }

async function pushLoad() {
    try {
        const txt = await Deno.readTextFile(PUSH_FILE);
        const arr = JSON.parse(txt);
        if (!Array.isArray(arr)) return;
        for (const it of arr) {
            if (!it || !it.sub || !it.sub.endpoint) continue;
            pushSubs.set(String(it.sub.endpoint), {
                sub: it.sub,
                nick: String(it.nick || ""),
                rooms: new Set<string>(Array.isArray(it.rooms) ? it.rooms : []),
                at: Number(it.at || Date.now()),
            });
        }
        console.log(`[nexus-ws] Web Push: подписок загружено из файла — ${pushSubs.size}`);
    } catch (_) { /* файла нет — обычный первый запуск */ }
}

async function pushStore() {
    if (!pushDirty) return;
    pushDirty = false;
    try {
        const arr: any[] = [];
        for (const [ep, rec] of pushSubs) {
            arr.push({ endpoint: ep, sub: rec.sub, nick: rec.nick, rooms: [...rec.rooms], at: rec.at });
        }
        await Deno.writeTextFile(PUSH_FILE, JSON.stringify(arr));
    } catch (_) { /* нет прав на запись — работаем только в памяти */ }
}

function pushSave(endpoint: string, sub: any, nick: string, room?: string) {
    if (!endpoint) return;
    let rec = pushSubs.get(endpoint);
    if (!rec) {
        rec = { sub, nick: nick || "", rooms: new Set<string>(), at: Date.now() };
        pushSubs.set(endpoint, rec);
    }
    if (sub) rec.sub = sub;
    if (nick) rec.nick = nick;
    rec.at = Date.now();
    if (room && room !== "__dir__") rec.rooms.add(room);
    pushPersist();
}

function pushDrop(endpoint: string) {
    if (endpoint) { pushSubs.delete(endpoint); pushPersist(); }
}

async function pushSendOne(endpoint: string, rec: PushRec, payload: any) {
    if (!webpush || !rec || !rec.sub) return;
    try {
        await webpush.sendNotification(rec.sub, JSON.stringify(payload));
    } catch (e: any) {
        const code = e && e.statusCode;
        // 404 / 410 — подписка умерла (браузер её отозвал), чистим
        if (code === 404 || code === 410) pushSubs.delete(endpoint);
    }
}

/* уведомить участников канала о новом сообщении.
   Кому уведомление уже пришло в открытое приложение — не шумим (его сокет в комнате). */
function pushNotify(room: string, senderNick: string) {
    if (!PUSH_ENABLED) return;
    if (!room || room === "__dir__") return;
    if (pushSubs.size === 0) return;

    // кто прямо сейчас сидит в комнате — тому push не нужен (он и так видит чат)
    const skip = new Set<string>();
    const liveNicks = new Set<string>();
    const r = rooms.get(room);
    if (r) for (const c of r) {
        if (c.pushEnd) skip.add(c.pushEnd);
        if (c.nick) liveNicks.add(c.nick);
    }

    const now = Date.now();
    const last = pushLast.get(room) || 0;
    if (now - last < PUSH_THROTTLE) {
        pushPending.set(room, (pushPending.get(room) || 0) + 1);
        return;
    }
    const extra = pushPending.get(room) || 0;
    pushPending.set(room, 0);
    pushLast.set(room, now);

    const payload = {
        title: "💬 " + (roomNames.get(room) || "канал"),
        body: "Новое сообщение" + (extra > 0 ? " (и ещё " + extra + ")" : ""),
        tag: "nx-" + room,
        room,
        url: "./?room=" + encodeURIComponent(room),
        ts: now,
    };

    for (const [endpoint, rec] of pushSubs) {
        if (!rec.rooms.has(room)) continue;
        if (skip.has(endpoint)) continue;
        if (rec.nick && liveNicks.has(rec.nick)) continue;
        if (rec.nick && senderNick && rec.nick === senderNick) continue;
        pushSendOne(endpoint, rec, payload);
    }
}

/* досылаем накопившееся после «тишины» */
function pushFlush() {
    if (!PUSH_ENABLED) return;
    const now = Date.now();
    for (const [room, n] of pushPending) {
        if (!n) continue;
        if (now - (pushLast.get(room) || 0) < PUSH_THROTTLE) continue;
        pushPending.set(room, 0);
        pushLast.set(room, now);
        const payload = {
            title: "💬 " + (roomNames.get(room) || "канал"),
            body: "Новых сообщений: " + n,
            tag: "nx-" + room,
            room,
            url: "./?room=" + encodeURIComponent(room),
            ts: now,
        };
        for (const [endpoint, rec] of pushSubs) {
            if (!rec.rooms.has(room)) continue;
            pushSendOne(endpoint, rec, payload);
        }
    }
}

type Client = {
    socket: WebSocket;
    room: string;
    id: string;
    nick: string;
    alive: boolean;
    pushEnd?: string;   // endpoint подписки этого сокета (для «не шуметь» в открытом чате)
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

    /* --- Web Push: браузер присылает свою подписку --- */
    if (msg.t === "sub") {
        const sub: any = msg.d || msg.sub;
        if (sub && sub.endpoint) {
            const ep = String(sub.endpoint).slice(0, 500);
            client.pushEnd = ep;
            pushSave(ep, sub, client.nick || String(msg.nick || "").slice(0, 40), client.room || String(msg.room || ""));
            send(client, { t: "subok", push: PUSH_ENABLED });
        }
        return;
    }

    /* --- Web Push: отписка (человек выключил уведомления) --- */
    if (msg.t === "unsub") {
        const sub: any = msg.d || msg.sub || {};
        const ep = String(sub.endpoint || client.pushEnd || "");
        pushDrop(ep);
        client.pushEnd = undefined;
        send(client, { t: "subok", push: false });
        return;
    }

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
        // push-уведомление тем, кто НЕ сидит в канале прямо сейчас
        if (msg.d && msg.d.kind !== "typing") pushNotify(room, client.nick);
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
Deno.serve({ port: PORT }, async (request) => {
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
            /* vapid — ПУБЛИЧНЫЙ ключ, он не секрет: клиент берёт его отсюда,
               чтобы подписаться на push. Приватный ключ остаётся только в env. */
            send(client, { t: "hello", id: client.id, server: "nexus-ws", vapid: VAPID_PUBLIC, push: PUSH_ENABLED, ts: Date.now() });
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
            tg: { enabled: TG_ENABLED, subs: tgSubs.size, rooms: roomNames.size },
            push: { enabled: PUSH_ENABLED, subs: pushSubs.size, rooms: pushLast.size },
            roomStats,
            ts: Date.now(),
        });
    }

    // --- Web Push: публичный VAPID-ключ (клиент может взять и здесь) ---
    if (url.pathname === "/push/vapid") {
        return json({ ok: true, enabled: PUSH_ENABLED, key: VAPID_PUBLIC });
    }

    // --- Web Push: тестовое уведомление (проверка, что всё настроено) ---
    if (url.pathname === "/push/test") {
        if (!PUSH_ENABLED) return json({ ok: false, error: "push выключен: нет VAPID-ключей" }, 503);
        if (pushSubs.size === 0) return json({ ok: false, error: "нет ни одной подписки" }, 404);
        let sent = 0;
        for (const [ep, rec] of pushSubs) {
            pushSendOne(ep, rec, {
                title: "🔔 Nexus Chat",
                body: "Тестовое уведомление — всё работает!",
                tag: "nx-test",
                url: "./",
                ts: Date.now(),
            });
            sent++;
        }
        return json({ ok: true, sent, subs: pushSubs.size });
    }

    // --- Web Push: сохранение подписки браузера ---
    if (url.pathname === "/subscribe" && request.method === "POST") {
        try {
            const body: any = await request.json();
            const sub = body && (body.sub || body.subscription);
            if (!sub || !sub.endpoint) return json({ ok: false, error: "нет endpoint" }, 400);
            const ep = String(sub.endpoint).slice(0, 500);
            pushSave(ep, sub, String((body && body.nick) || "").slice(0, 40));
            const rec = pushSubs.get(ep);
            const roomList = Array.isArray(body && body.rooms) ? body.rooms : [];
            if (rec) for (const r of roomList) if (r && r !== "__dir__") rec.rooms.add(String(r));
            return json({ ok: true, push: PUSH_ENABLED, subs: pushSubs.size });
        } catch (_) {
            return json({ ok: false, error: "плохой JSON" }, 400);
        }
    }

    // --- Web Push: отписка ---
    if (url.pathname === "/unsubscribe" && request.method === "POST") {
        try {
            const body: any = await request.json();
            pushDrop(String((body && body.endpoint) || ""));
            return json({ ok: true, subs: pushSubs.size });
        } catch (_) {
            return json({ ok: false, error: "плохой JSON" }, 400);
        }
    }

    return json({ ok: false, error: "Not found" }, 404);
});

console.log(`[nexus-ws] WebSocket relay запущен на порту ${PORT}`);
console.log(TG_ENABLED
    ? "[nexus-ws] Telegram-уведомления: ВКЛ (напиши боту /start ТвойНик)"
    : "[nexus-ws] Telegram-уведомления: ВЫКЛ (нет TELEGRAM_TOKEN)");

if (TG_ENABLED) {
    tgPoll();
    setInterval(tgPoll, 3_000);
    setInterval(tgFlush, 5_000);
}

// Web Push: досылаем накопившиеся уведомления + подсказка по ключам
setInterval(pushFlush, 5_000);
// Web Push: подписки грузим из файла и периодически сохраняем
pushLoad();
setInterval(pushStore, 10_000);
console.log(PUSH_ENABLED
    ? "[nexus-ws] Web Push: уведомления браузера активны"
    : "[nexus-ws] Web Push: задай VAPID_PUBLIC / VAPID_PRIVATE, чтобы включить уведомления");

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

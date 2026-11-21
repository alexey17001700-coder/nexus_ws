// nexus_ws/ai.ts — ИИ-шлюз Штаба (помощник Архитектора)
// Запуск: deno run --allow-net --allow-env --allow-read ai.ts
// Порт: AI_PORT || 8002. Порт чата (8001) не занимает, main.ts не трогает.
// Ключи — ТОЛЬКО из переменных окружения. В коде секретов нет.

const PORT = Number(Deno.env.get("AI_PORT") || 8002);

// --- Доступ к GitHub (инструменты Помощника) ---
// Пока GITHUB_TOKEN не задан — Помощник только советует, файлы не трогает.
const GH_TOKEN = env("GITHUB_TOKEN", "GH_TOKEN");
const GH_OWNER = env("GITHUB_OWNER", "GH_USER");
const MAX_ROUNDS = Number(env("AI_MAX_ROUNDS") || 6);
const PROTECTED_FILES = ["main.ts"];
const PROTECTED_DIRS = ["backup/"];
const toolsEnabled = (): boolean => !!GH_TOKEN && !!GH_OWNER;

type Msg = { role: "system" | "user" | "assistant"; content: string };

interface Provider {
  name: string;
  model: string;
  url: string;
  key: string;
  note: string;
}

function env(...names: string[]): string {
  for (const n of names) {
    const v = Deno.env.get(n);
    if (v && v.trim()) return v.trim();
  }
  return "";
}

// Провайдер по умолчанию, если Boss не выбрал модель
const DEFAULT_NAME = env("AI_DEFAULT") || "";

// Персона Архитектора (можно переопределить через AI_SYSTEM)
const SYSTEM =
  env("AI_SYSTEM") ||
  [
    "Ты — Цифровой Архитектор Штаба. Senior-инженер и сисадмин проекта Босса.",
    "Работаешь в паре с главным Архитектором: помогаешь, когда он занят.",
    "Правила: думай коротко, действуй сразу, без воды и пересказа промпта.",
    "Отвечай по-русски, по делу: что сделал, где, ссылка.",
    "Проекты: digital-agency (Штаб), nexus_chat/nexus_ws (чат), window_calc (окна),",
    "ac_luxury_calc (кондиционеры), window_measure_pro (замер окон), nexus_snake.",
    "Сервер: Vivo Y17 → Termux → Ubuntu. Штаб :8000, Чат :8001, Caddy :8443.",
    "Секреты в открытый репозиторий НЕ писать — только переменные окружения.",
    "Файл main.ts и папку backup не удалять. Правки — точечные.",
  ].join(" ");

// --- Память Помощника: ai_memory.md рядом с ai.ts ---
// Файл необязательный. Если его нет — работаем без памяти.
let MEMORY = "";
async function loadMemory(): Promise<string> {
  try {
    MEMORY = await Deno.readTextFile(new URL("./ai_memory.md", import.meta.url));
  } catch {
    MEMORY = "";
  }
  return MEMORY;
}
await loadMemory();

function systemPrompt(): string {
  if (!MEMORY.trim()) return SYSTEM;
  return SYSTEM + "\n\n--- ПАМЯТЬ ПРОЕКТА (ai_memory.md) ---\n" + MEMORY.trim();
}

// --- Провайдеры (все OpenAI-совместимые) ---
function buildChain(): Provider[] {
  const chain: Provider[] = [];
  const add = (name: string, model: string, url: string, key: string, note: string) => {
    if (key) chain.push({ name, model, url, key, note });
  };

  add(
    "GLM",
    env("GLM_MODEL") || "glm-4-flash",
    env("GLM_URL") || "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    env("GLM_KEY", "ZHIPU_KEY"),
    "бесплатно",
  );
  add(
    "DeepSeek",
    env("DEEPSEEK_MODEL") || "deepseek-chat",
    env("DEEPSEEK_URL") || "https://api.deepseek.com/chat/completions",
    env("DEEPSEEK_KEY"),
    "платно, копейки",
  );
  add(
    "VseGPT",
    env("VSEGPT_MODEL") || "gpt-3.5-turbo",
    env("VSEGPT_URL") || "https://api.vsegpt.ru/v1/chat/completions",
    env("VSEGPT_KEY"),
    "российский шлюз",
  );
  add(
    "OpenRouter",
    env("OPENROUTER_MODEL") || "meta-llama/llama-3.1-8b-instruct:free",
    env("OPENROUTER_URL") || "https://openrouter.ai/api/v1/chat/completions",
    env("OPENROUTER_KEY"),
    "free-модели",
  );
  add(
    "Groq",
    env("GROQ_MODEL") || "llama-3.3-70b-versatile",
    env("GROQ_URL") || "https://api.groq.com/openai/v1/chat/completions",
    env("GROQ_KEY"),
    "быстро, free tier",
  );

  // Приоритет: если задан AI_DEFAULT — он встаёт первым
  if (DEFAULT_NAME) {
    const i = chain.findIndex((p) => p.name.toLowerCase() === DEFAULT_NAME.toLowerCase());
    if (i > 0) {
      const [p] = chain.splice(i, 1);
      chain.unshift(p);
    }
  }
  return chain;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function clean(messages: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (const m of messages || []) {
    if (!m || typeof m.content !== "string") continue;
    const role = m.role === "assistant" || m.role === "system" ? m.role : "user";
    const content = m.content.slice(0, 20000);
    if (!content.trim()) continue;
    out.push({ role, content });
  }
  return out.slice(-24); // не раздуваем контекст
}

// --- Один вызов провайдера ---
async function callProvider(
  p: Provider,
  messages: any[],
  temperature: number,
  tools?: any[],
): Promise<{ text: string; raw: unknown; message: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${p.key}`,
  };
  if (p.name === "OpenRouter") {
    headers["HTTP-Referer"] = "https://shtab-boss.duckdns.org";
    headers["X-Title"] = "Shtab AI";
  }

  const res = await fetch(p.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: p.model, messages, temperature, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });

  const bodyText = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = null;
  }

  if (!res.ok) {
    const detail =
      data?.error?.message || data?.message || bodyText.slice(0, 300) || `HTTP ${res.status}`;
    const err = new Error(detail);
    (err as any).status = res.status;
    throw err;
  }

  const text =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.response ??
    "";

  if (!text || !String(text).trim()) {
    throw new Error("Пустой ответ модели");
  }
  return { text: String(text).trim(), raw: data };
}

// --- Роутер: пробуем по цепочке, лимит/ошибка → следующий ---
async function route(
  messages: Msg[],
  temperature: number,
  only?: string,
): Promise<{ ok: boolean; text?: string; provider?: string; model?: string; tried: any[]; ms: number }> {
  const chain = buildChain();
  const list = only
    ? chain.filter((p) => p.name.toLowerCase() === only.toLowerCase())
    : chain;

  const tried: any[] = [];
  const t0 = Date.now();

  if (!list.length) {
    return { ok: false, tried, ms: 0 };
  }

  for (const p of list) {
    const ts = Date.now();
    try {
      const r = await callProvider(p, messages, temperature);
      tried.push({ provider: p.name, model: p.model, ok: true, ms: Date.now() - ts });
      return {
        ok: true,
        text: r.text,
        provider: p.name,
        model: p.model,
        tried,
        ms: Date.now() - t0,
      };
    } catch (e) {
      tried.push({
        provider: p.name,
        model: p.model,
        ok: false,
        status: (e as any).status || 0,
        error: String((e as any)?.message || e).slice(0, 300),
        ms: Date.now() - ts,
      });
      // 401/403 — ключ мёртв, тоже идём дальше
    }
  }

  return { ok: false, tried, ms: Date.now() - t0 };
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Состояние шлюза: какие провайдеры настроены (ключи НЕ показываем)
  if (url.pathname === "/ai/health" || url.pathname === "/health") {
    const chain = buildChain();
    return json({
      ok: true,
      port: PORT,
      providers: chain.map((p) => ({ name: p.name, model: p.model, note: p.note })),
      default: DEFAULT_NAME || (chain[0]?.name ?? ""),
      count: chain.length,
    });
  }

  // Память: сколько загружено. ?reload=1 — перечитать файл без перезапуска.
  if (url.pathname === "/ai/memory") {
    if (url.searchParams.get("reload")) await loadMemory();
    return json({
      ok: true,
      loaded: MEMORY.length > 0,
      chars: MEMORY.length,
      lines: MEMORY ? MEMORY.split("\n").length : 0,
    });
  }

  if (url.pathname === "/ai/models") {
    const chain = buildChain();
    return json({
      ok: true,
      models: chain.map((p) => ({ name: p.name, model: p.model, note: p.note })),
    });
  }

  if (url.pathname === "/ai" && req.method === "POST") {
    let payload: any = null;
    try {
      payload = await req.json();
    } catch {
      return json({ ok: false, error: "Некорректный JSON" }, 400);
    }

    const messages = clean(payload?.messages || []);
    if (!messages.length) {
      return json({ ok: false, error: "Пустой запрос" }, 400);
    }

    // Персону подставляем, если клиент не прислал свой system
    if (!messages.some((m) => m.role === "system")) {
      messages.unshift({ role: "system", content: systemPrompt() });
    }

    const temperature = typeof payload?.temperature === "number"
      ? Math.min(Math.max(payload.temperature, 0), 1.5)
      : 0.6;

    const only = typeof payload?.provider === "string" ? payload.provider : "";

    const r = await route(messages, temperature, only);

    if (!r.ok) {
      return json({
        ok: false,
        error: r.tried.length
          ? "Все провайдеры недоступны"
          : "Ни один ключ не настроен (см. .env.example)",
        tried: r.tried,
        ms: r.ms,
      }, 503);
    }

    return json({
      ok: true,
      text: r.text,
      provider: r.provider,
      model: r.model,
      tried: r.tried,
      ms: r.ms,
    });
  }

  return json({ ok: false, error: "Не найдено" }, 404);
});

console.log(`🤖 ИИ-шлюз Штаба слушает :${PORT}`);
console.log(`   Провайдеры: ${buildChain().map((p) => p.name).join(", ") || "— ключей нет —"}`);

// nexus_ws/ai.ts — ИИ-шлюз Штаба (помощник Архитектора)
// Запуск: deno run --allow-net --allow-env --allow-read ai.ts
// Порт: AI_PORT || 8002. Порт чата (8001) не занимает, main.ts не трогает.
// Ключи — ТОЛЬКО из переменных окружения. В коде секретов нет.

import { runTool, TOOL_SPEC, toolsEnabled } from "./ai_tools.ts";

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
  let base = SYSTEM;
  if (MEMORY.trim()) {
    base += "\n\n--- ПАМЯТЬ ПРОЕКТА (ai_memory.md) ---\n" + MEMORY.trim();
  }
  if (toolsEnabled()) base += "\n\n" + TOOL_SPEC;
  return base;
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
    body: JSON.stringify({
      model: p.model,
      messages,
      temperature,
      stream: false,
      ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    }),
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

  const message = data?.choices?.[0]?.message ?? null;
  const text =
    message?.content ??
    data?.choices?.[0]?.text ??
    data?.response ??
    "";

  const hasCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  if (!hasCalls && (!text || !String(text).trim())) {
    throw new Error("Пустой ответ модели");
  }
  return { text: String(text || "").trim(), raw: data, message };
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

// ============================================================
// ИНСТРУМЕНТЫ: Помощник читает и правит файлы в репозиториях.
// Работают только при заданных GITHUB_TOKEN и GITHUB_OWNER.
// ============================================================

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_repo_files",
      description: "Список файлов в корне репозитория.",
      parameters: {
        type: "object",
        properties: { repo: { type: "string", description: "Имя репозитория" } },
        required: ["repo"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Прочитать файл из репозитория.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string" },
          path: { type: "string", description: "Путь к файлу" },
        },
        required: ["repo", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Записать файл целиком (создать или перезаписать).",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string" },
          path: { type: "string" },
          content: { type: "string", description: "ПОЛНЫЙ новый код файла" },
          message: { type: "string", description: "Комментарий коммита" },
        },
        required: ["repo", "path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "Точечная замена фрагмента. Фрагмент search должен встречаться ровно один раз.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string" },
          path: { type: "string" },
          search: { type: "string", description: "Что заменить (точь-в-точь)" },
          replace: { type: "string", description: "На что заменить" },
          message: { type: "string" },
        },
        required: ["repo", "path", "search", "replace"],
      },
    },
  },
];

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): string {
  const bin = atob(String(s).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function gh(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch("https://api.github.com" + path, {
    ...init,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${GH_TOKEN}`,
      "User-Agent": "shtab-ai",
      "X-GitHub-Api-Version": "2022-11-28",
      ...((init?.headers as Record<string, string>) || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data?.message || `GitHub HTTP ${res.status}`);
  return data;
}

function guard(path: string, action: string): string {
  if (!path) return "не указан путь";
  if (PROTECTED_DIRS.some((d) => path.startsWith(d))) return `папка ${path} защищена`;
  if (PROTECTED_FILES.includes(path) && action !== "read") return `файл ${path} защищён — правки только вручную`;
  return "";
}

async function ghRead(repo: string, path: string): Promise<{ content: string; sha: string }> {
  const d = await gh(`/repos/${GH_OWNER}/${repo}/contents/${encodeURI(path)}`);
  if (Array.isArray(d)) throw new Error("это папка — используй list_repo_files");
  return { content: b64decode(d.content || ""), sha: d.sha };
}

async function ghWrite(repo: string, path: string, content: string, message?: string): Promise<void> {
  let sha: string | undefined;
  try {
    sha = (await ghRead(repo, path)).sha;
  } catch {
    sha = undefined;
  }
  const body: any = { message: message || `ai: ${path}`, content: b64encode(content) };
  if (sha) body.sha = sha;
  await gh(`/repos/${GH_OWNER}/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function executeTool(name: string, args: any): Promise<string> {
  try {
    const repo = String(args?.repo || "digital-agency");
    const path = String(args?.path || "");

    if (name === "list_repo_files") {
      const d = await gh(`/repos/${GH_OWNER}/${repo}/contents/`);
      if (!Array.isArray(d)) return "пусто";
      return d.map((f: any) => `${f.type === "dir" ? "📁" : "📄"} ${f.name}`).join("\n");
    }

    if (name === "read_file") {
      const r = await ghRead(repo, path);
      return r.content.slice(0, 60000);
    }

    if (name === "write_file") {
      const g = guard(path, "write");
      if (g) return "ОТКАЗ: " + g;
      const content = String(args?.content ?? "");
      await ghWrite(repo, path, content, args?.message);
      return `OK: записан ${repo}/${path} (${content.length} симв.)`;
    }

    if (name === "replace_in_file") {
      const g = guard(path, "replace");
      if (g) return "ОТКАЗ: " + g;
      const search = String(args?.search ?? "");
      const replace = String(args?.replace ?? "");
      if (!search) return "ОТКАЗ: пустой search";
      const r = await ghRead(repo, path);
      const n = r.content.split(search).length - 1;
      if (n === 0) return `ОТКАЗ: фрагмент не найден в ${repo}/${path}`;
      if (n > 1) return `ОТКАЗ: фрагмент встречается ${n} раз — уточни search`;
      await ghWrite(repo, path, r.content.replace(search, replace), args?.message || `ai: правка ${path}`);
      return `OK: правка внесена в ${repo}/${path}`;
    }

    return "Неизвестный инструмент: " + name;
  } catch (e) {
    return "ОШИБКА: " + String((e as any)?.message || e).slice(0, 300);
  }
}

// --- Агент: модель просит инструмент → сервер выполняет → отдаёт результат ---
async function runAgent(
  messages: any[],
  temperature: number,
  only?: string,
): Promise<{ ok: boolean; text?: string; provider?: string; model?: string; tried: any[]; actions: string[]; ms: number }> {
  const chain = buildChain();
  const list = only ? chain.filter((p) => p.name.toLowerCase() === only.toLowerCase()) : chain;
  const tried: any[] = [];
  const actions: string[] = [];
  const t0 = Date.now();

  if (!list.length) return { ok: false, tried, actions, ms: 0 };

  const useTools = toolsEnabled();
  const convo: any[] = messages.slice();

  for (const p of list) {
    const ts = Date.now();
    try {
      let text = "";
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const r = await callProvider(p, convo, temperature, useTools ? TOOLS : undefined);
        const calls = Array.isArray(r.message?.tool_calls) ? r.message.tool_calls : [];
        if (!calls.length) {
          text = r.text;
          break;
        }
        convo.push({ role: "assistant", content: r.message?.content || "", tool_calls: calls });
        for (const c of calls) {
          let a: any = {};
          try {
            a = JSON.parse(c?.function?.arguments || "{}");
          } catch {
            a = {};
          }
          const out = await executeTool(c?.function?.name, a);
          actions.push(
            `${c?.function?.name}(${a?.repo || ""}${a?.path ? "/" + a.path : ""}) → ${out.slice(0, 160)}`,
          );
          convo.push({ role: "tool", tool_call_id: c?.id, content: out.slice(0, 20000) });
        }
      }
      tried.push({ provider: p.name, model: p.model, ok: true, ms: Date.now() - ts });
      return {
        ok: true,
        text: text || "(инструменты выполнены)",
        provider: p.name,
        model: p.model,
        tried,
        actions,
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
    }
  }

  return { ok: false, tried, actions, ms: Date.now() - t0 };
}

// --- Инструменты: модель просит действие, сервер выполняет, отдаёт результат ---
const TOOL_RE = /<tool>\s*([\s\S]*?)\s*<\/tool>/i;

async function runWithTools(
  messages: Msg[],
  temperature: number,
  only: string,
  maxSteps = 6,
): Promise<{
  ok: boolean;
  text?: string;
  provider?: string;
  model?: string;
  tried: any[];
  steps: any[];
  ms: number;
}> {
  const t0 = Date.now();
  const steps: any[] = [];
  const tried: any[] = [];
  let last: any = null;
  let msgs = messages;

  for (let i = 0; i < maxSteps; i++) {
    const r = await route(msgs, temperature, only);
    if (!r.ok) return { ok: false, tried: r.tried, steps, ms: Date.now() - t0 };
    last = r;
    tried.push(...r.tried);

    const m = String(r.text || "").match(TOOL_RE);
    if (!m) {
      return {
        ok: true,
        text: r.text,
        provider: r.provider,
        model: r.model,
        tried,
        steps,
        ms: Date.now() - t0,
      };
    }

    let call: any = null;
    try {
      call = JSON.parse(m[1]);
    } catch {
      call = null;
    }

    let result = "";
    if (!call || !call.name) {
      result = 'Ошибка: не разобрал вызов. Нужен JSON вида {"name":"...","args":{...}}';
    } else {
      const out = await runTool(String(call.name), call.args || {});
      result = out.text;
      steps.push({
        name: String(call.name),
        args: call.args || {},
        ok: out.ok,
        chars: out.text.length,
      });
    }

    msgs = msgs.concat([
      { role: "assistant", content: String(r.text).slice(0, 4000) },
      {
        role: "user",
        content: "РЕЗУЛЬТАТ ИНСТРУМЕНТА:\n" + result.slice(0, 20000) +
          "\n\nПродолжай. Если задача выполнена — дай короткий отчёт Боссу.",
      },
    ]);
  }

  return {
    ok: true,
    text: String(last?.text || "") + "\n\n(остановлен: превышен лимит шагов инструментов)",
    provider: last?.provider,
    model: last?.model,
    tried,
    steps,
    ms: Date.now() - t0,
  };
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
      tools: toolsEnabled() ? "on" : "off",
      owner: GH_OWNER || "",
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

  // Инструменты: включены ли (настроен ли токен GitHub)
  if (url.pathname === "/ai/tools") {
    return json({
      ok: true,
      enabled: toolsEnabled(),
      hint: toolsEnabled()
        ? "Помощник может читать и править файлы репозиториев"
        : "Нужны GITHUB_TOKEN и GITHUB_OWNER в .env",
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

    // Инструменты включаем, если есть токен GitHub и клиент не отключил их
    const wantTools = payload?.tools !== false && toolsEnabled();
    const r = wantTools
      ? await runAgent(messages, temperature, only)
      : await route(messages, temperature, only);

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
      actions: (r as any).actions || [],
      ms: r.ms,
    });
  }

  return json({ ok: false, error: "Не найдено" }, 404);
});

console.log(`🤖 ИИ-шлюз Штаба слушает :${PORT}`);
console.log(`   Провайдеры: ${buildChain().map((p) => p.name).join(", ") || "— ключей нет —"}`);
console.log(`   Инструменты GitHub: ${toolsEnabled() ? "включены" : "выключены (нет GITHUB_TOKEN / GITHUB_OWNER)"}`);

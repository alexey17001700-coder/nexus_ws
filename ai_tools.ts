// nexus_ws/ai_tools.ts — инструменты Помощника: доступ к GitHub-репозиториям.
// Подключается из ai.ts. Секреты — ТОЛЬКО из окружения:
//   GITHUB_TOKEN — токен (fine-grained: Contents = Read and write)
//   GITHUB_OWNER — владелец репозиториев (логин на GitHub)
// В открытый репозиторий токен НЕ попадает.

const API = "https://api.github.com";

function env(...names: string[]): string {
  for (const n of names) {
    const v = Deno.env.get(n);
    if (v && v.trim()) return v.trim();
  }
  return "";
}

const TOKEN = env("GITHUB_TOKEN", "GH_TOKEN");
const OWNER = env("GITHUB_OWNER", "GH_OWNER");

// --- Защита: что удалять нельзя ---
const NO_DELETE_REPOS = ["digital-agency", "window_calc"];
const NO_DELETE_FILES = ["main.ts"];
const NO_DELETE_PREFIX = ["backup/"];

const MAX_READ = 60_000;   // сколько символов файла отдаём модели
const MAX_WRITE = 400_000; // предохранитель от гигантских записей

export function toolsEnabled(): boolean {
  return Boolean(TOKEN && OWNER);
}

export interface ToolOut {
  ok: boolean;
  text: string;
}

function fail(text: string): ToolOut {
  return { ok: false, text: "ОШИБКА: " + text };
}

function ok(text: string): ToolOut {
  return { ok: true, text };
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(API + path, {
    ...init,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "shtab-ai-tools",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): string {
  const bin = atob(String(s).replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function slug(v: unknown): string {
  return String(v || "").trim().replace(/^\/+|\/+$/g, "");
}

async function getFile(
  repo: string,
  path: string,
): Promise<{ sha: string; content: string } | null> {
  const r = await gh(`/repos/${OWNER}/${repo}/contents/${encodeURI(path)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  if (Array.isArray(j)) throw new Error("Это папка, а не файл");
  if (!j.content) return { sha: j.sha, content: "" };
  return { sha: j.sha, content: b64decode(j.content) };
}

async function putFile(
  repo: string,
  path: string,
  content: string,
  message: string,
  sha?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    message,
    content: b64encode(content),
  };
  if (sha) body.sha = sha;

  const r = await gh(`/repos/${OWNER}/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// --- Инструменты ---

async function listRepos(): Promise<ToolOut> {
  const r = await gh("/user/repos?per_page=100&sort=updated");
  if (!r.ok) return fail(`GitHub ${r.status}`);
  const j: any = await r.json();
  const names = (Array.isArray(j) ? j : []).map((x: any) => x.name);
  return ok(names.length ? names.join("\n") : "Репозиториев нет");
}

async function listRepoFiles(repo: string): Promise<ToolOut> {
  if (!repo) return fail("не указан repo");
  const r = await gh(`/repos/${OWNER}/${repo}/contents/`);
  if (r.status === 404) return fail(`репозиторий ${repo} не найден`);
  if (!r.ok) return fail(`GitHub ${r.status}`);
  const j: any = await r.json();
  const list = (Array.isArray(j) ? j : []).map((x: any) =>
    x.type === "dir" ? x.name + "/" : x.name
  );
  return ok(`Файлы ${repo}:\n` + list.join("\n"));
}

async function readFile(repo: string, path: string): Promise<ToolOut> {
  if (!repo || !path) return fail("нужны repo и path");
  const f = await getFile(repo, path);
  if (!f) return fail(`файл ${repo}/${path} не найден`);
  const cut = f.content.length > MAX_READ;
  return ok(
    `Файл ${repo}/${path} (${f.content.length} символов):\n\n` +
      f.content.slice(0, MAX_READ) +
      (cut ? "\n\n… (обрезано, файл больше)" : ""),
  );
}

async function writeFile(
  repo: string,
  path: string,
  content: string,
  force: boolean,
): Promise<ToolOut> {
  if (!repo || !path) return fail("нужны repo и path");
  if (typeof content !== "string") return fail("нужен content");
  if (content.length > MAX_WRITE) return fail("слишком большой content");
  if (path === "main.ts" && !force) {
    return fail("main.ts меняется только по прямому приказу Босса — нужен force:true");
  }

  const old = await getFile(repo, path);
  await putFile(
    repo,
    path,
    content,
    old ? `AI: обновлён ${path}` : `AI: создан ${path}`,
    old?.sha,
  );
  return ok(
    `${old ? "Обновлён" : "Создан"} ${repo}/${path} — ${content.length} символов.`,
  );
}

async function replaceInFile(
  repo: string,
  path: string,
  search: string,
  replace: string,
  force: boolean,
): Promise<ToolOut> {
  if (!repo || !path) return fail("нужны repo и path");
  if (typeof search !== "string" || !search) return fail("нужен search");
  if (typeof replace !== "string") return fail("нужен replace");
  if (path === "main.ts" && !force) {
    return fail("main.ts меняется только по прямому приказу Босса — нужен force:true");
  }

  const f = await getFile(repo, path);
  if (!f) return fail(`файл ${repo}/${path} не найден`);

  const hits = f.content.split(search).length - 1;
  if (hits === 0) {
    return fail(
      `фрагмент не найден в ${repo}/${path}. Прочитай файл (read_file) и повтори с точным текстом.`,
    );
  }
  if (hits > 1) {
    return fail(`фрагмент встречается ${hits} раз — уточни search, чтобы правка была однозначной.`);
  }

  const next = f.content.replace(search, replace);
  await putFile(repo, path, next, `AI: правка ${path}`, f.sha);
  return ok(
    `Правка внесена: ${repo}/${path} (${f.content.length} → ${next.length} символов).`,
  );
}

async function deleteFile(repo: string, path: string): Promise<ToolOut> {
  if (!repo || !path) return fail("нужны repo и path");
  if (NO_DELETE_REPOS.includes(repo)) {
    return fail(`репозиторий ${repo} защищён — удаление запрещено`);
  }
  if (NO_DELETE_FILES.includes(path)) {
    return fail(`файл ${path} защищён — удаление запрещено`);
  }
  if (NO_DELETE_PREFIX.some((p) => path.startsWith(p))) {
    return fail(`папка ${path} защищена — удаление запрещено`);
  }

  const f = await getFile(repo, path);
  if (!f) return fail(`файл ${repo}/${path} не найден`);

  const r = await gh(`/repos/${OWNER}/${repo}/contents/${encodeURI(path)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: `AI: удалён ${path}`, sha: f.sha }),
  });
  if (!r.ok) return fail(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ok(`Удалён ${repo}/${path}.`);
}

// --- Диспетчер ---
export async function runTool(name: string, args: Record<string, unknown>): Promise<ToolOut> {
  if (!toolsEnabled()) {
    return fail("инструменты выключены: нет GITHUB_TOKEN / GITHUB_OWNER в .env");
  }
  const repo = slug(args?.repo) || "digital-agency";
  const path = slug(args?.path);
  const force = args?.force === true;

  try {
    switch (String(name || "").trim()) {
      case "list_repos":
        return await listRepos();
      case "list_repo_files":
        return await listRepoFiles(repo);
      case "read_file":
        return await readFile(repo, path);
      case "write_file":
        return await writeFile(repo, path, String(args?.content ?? ""), force);
      case "replace_in_file":
        return await replaceInFile(
          repo,
          path,
          String(args?.search ?? ""),
          String(args?.replace ?? ""),
          force,
        );
      case "delete_file":
        return await deleteFile(repo, path);
      default:
        return fail(`неизвестный инструмент «${name}»`);
    }
  } catch (e) {
    return fail(String((e as any)?.message || e).slice(0, 300));
  }
}

// --- Инструкция для модели (подставляется в системный промпт) ---
export const TOOL_SPEC = [
  "ИНСТРУМЕНТЫ (доступ к GitHub-репозиториям Босса).",
  "Чтобы выполнить действие — выведи РОВНО ОДИН блок и остановись. Сервер выполнит его и вернёт результат:",
  "",
  '<tool>{"name":"read_file","args":{"path":"ai.js","repo":"digital-agency"}}</tool>',
  "",
  "Инструменты:",
  '- list_repos {} — список репозиториев',
  '- list_repo_files {"repo":"digital-agency"} — файлы в корне',
  '- read_file {"path":"style.css","repo":"digital-agency"} — прочитать файл',
  '- write_file {"path":"new.js","content":"...","repo":"digital-agency"} — создать/перезаписать файл ЦЕЛИКОМ',
  '- replace_in_file {"path":"app.html","search":"старый код","replace":"новый код","repo":"digital-agency"} — точечная правка (главный инструмент)',
  '- delete_file {"path":"test.js","repo":"digital-agency"} — удалить файл',
  "",
  "Правила:",
  "- Правки только точечные, через replace_in_file. Остальной код копируй слово в слово.",
  "- Не уверен в содержимом — сначала read_file.",
  '- main.ts меняется только по прямому приказу Босса (нужен "force": true).',
  "- backup/ и репозитории digital-agency, window_calc не удалять.",
  "- Секреты в репозитории не писать — только переменные окружения.",
  "- После инструментов дай короткий отчёт: что сделал, где, ссылка. Метку [ЭТАП N/M] ставь последней строкой.",
].join("\n");

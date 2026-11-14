// ============================================================
//  ГЕНЕРАТОР VAPID-КЛЮЧЕЙ ДЛЯ WEB PUSH
//  Запуск:  deno run gen_keys.ts
//  Ничего не ломает — это отдельный одноразовый скрипт.
// ============================================================

function b64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const kp = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
) as CryptoKeyPair;

// Публичный ключ — сырой формат (65 байт, начинается с 0x04)
const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);

// Приватный ключ — берём компонент "d" из JWK (32 байта)
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey) as JsonWebKey;
const d = jwk.d!.replace(/-/g, "+").replace(/_/g, "/");
const privRaw = Uint8Array.from(atob(d), (c) => c.charCodeAt(0));

const PUB = b64u(pubRaw);
const PRIV = b64u(privRaw);

console.log("");
console.log("═══════════════════════════════════════════════════════");
console.log("  VAPID КЛЮЧИ СГЕНЕРИРОВАНЫ");
console.log("═══════════════════════════════════════════════════════");
console.log("");
console.log("ПУБЛИЧНЫЙ (идёт в клиент, можно в открытый код):");
console.log("");
console.log(PUB);
console.log("");
console.log("ПРИВАТНЫЙ (ТОЛЬКО в переменную окружения на Vivo!)");
console.log("В репозиторий НЕ писать, в чат НЕ кидать:");
console.log("");
console.log(PRIV);
console.log("");
console.log("═══════════════════════════════════════════════════════");
console.log("  ЗАПУСК СЕРВЕРА С КЛЮЧАМИ");
console.log("═══════════════════════════════════════════════════════");
console.log("");
console.log("Скопируй одной строкой (замени почту на свою):");
console.log("");
console.log(
  `VAPID_PUBLIC=${PUB} \\\nVAPID_PRIVATE=${PRIV} \\\nVAPID_SUBJECT=mailto:boss@example.com \\\ndeno run --allow-net --allow-env --allow-read --allow-write main.ts`,
);
console.log("");
console.log("Совет: сохрани приватный ключ в надёжном месте (не в GitHub).");
console.log("Если потеряешь — придётся генерировать заново, старые подписки отвалятся.");
console.log("");

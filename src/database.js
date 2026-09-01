// src/database.js
// Capa de persistencia usando archivos JSON.
// Sin dependencias nativas — funciona en cualquier Node.js sin compiladores.
// Guarda recomendaciones, tokens OAuth y hash del historial.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../data");

const FILES = {
  recommendations: path.join(DATA_DIR, "recommendations.json"),
  tokens: path.join(DATA_DIR, "tokens.json"),
  historyHash: path.join(DATA_DIR, "history_hash.json"),
};

// Asegurar que el directorio data/ existe
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file, defaultValue) {
  try {
    if (!fs.existsSync(file)) return defaultValue;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return defaultValue;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

// ─── Recomendaciones ────────────────────────────────────────────────────────

/**
 * Reemplaza todas las recomendaciones para un catálogo dado.
 * @param {Array} items
 * @param {string} catalogId
 */
export function saveRecommendations(items, catalogId = "gemini-recommended") {
  const all = readJSON(FILES.recommendations, {});
  all[catalogId] = items.map((item) => ({ ...item, catalogId }));
  writeJSON(FILES.recommendations, all);
  console.log(`[DB] ${items.length} recomendaciones guardadas en "${catalogId}".`);
}

/**
 * Devuelve las recomendaciones guardadas para un catálogo, ordenadas por confidence.
 * @param {string} catalogId
 * @param {string|null} type - "movie" | "series" | null
 */
export function getRecommendations(catalogId = "gemini-recommended", type = null) {
  const all = readJSON(FILES.recommendations, {});
  let items = all[catalogId] || [];
  if (type) items = items.filter((i) => i.type === type);
  return items.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
}

// ─── Tokens OAuth ───────────────────────────────────────────────────────────

/**
 * Guarda o actualiza el token de Simkl.
 * @param {string} accessToken
 * @param {string|null} refreshToken
 * @param {number} expiresIn - segundos desde ahora
 */
export function saveToken(accessToken, refreshToken, expiresIn) {
  const expiresAt = Date.now() + expiresIn * 1000;
  writeJSON(FILES.tokens, { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt });
}

/**
 * Devuelve el token guardado o null.
 */
export function getToken() {
  return readJSON(FILES.tokens, null);
}

// ─── Hash del historial ─────────────────────────────────────────────────────

/**
 * Guarda el hash del historial para detectar cambios.
 * @param {string} hash
 */
export function saveHistoryHash(hash) {
  writeJSON(FILES.historyHash, { hash, updated_at: Date.now() });
}

/**
 * Devuelve el hash guardado o null.
 */
export function getHistoryHash() {
  return readJSON(FILES.historyHash, null)?.hash || null;
}

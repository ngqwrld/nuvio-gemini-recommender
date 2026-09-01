// src/recommendations.js
// Pipeline principal de recomendaciones.
// Orquesta Simkl → Gemini → TMDB → SQLite.
// Incluye comprobación de hash para evitar llamadas innecesarias a Gemini.

import crypto from "crypto";
import { getHistory, getRatings, getWatchlist, extractWatchedTitles } from "./simkl.js";
import { generateRecommendations } from "./gemini.js";
import { validateAndEnrich } from "./tmdb.js";
import {
  saveRecommendations,
  getRecommendations,
  saveHistoryHash,
  getHistoryHash,
} from "./database.js";

/**
 * Genera un hash SHA-256 de los primeros 50 títulos del historial.
 * Sirve para detectar si el historial cambió y solo llamar a Gemini si es necesario.
 */
function hashHistory(history) {
  const sample = history
    .slice(0, 50)
    .map((h) => h.title || "")
    .join("|");
  return crypto.createHash("sha256").update(sample).digest("hex");
}

/**
 * Ejecuta el pipeline completo y actualiza las recomendaciones en BD.
 * @param {boolean} force - Si true, omite la comprobación de hash y siempre llama a Gemini
 * @returns {{ updated: boolean, count: number, items: Array }}
 */
export async function updateRecommendations(force = false) {
  console.log("[Pipeline] Obteniendo datos de Simkl...");
  const [history, ratings, watchlist] = await Promise.all([
    getHistory(),
    getRatings(),
    getWatchlist(),
  ]);

  console.log(
    `[Pipeline] Historial: ${history.length} | Ratings: ${ratings.length} | Watchlist: ${watchlist.length}`
  );

  // Comprobar si el historial cambió
  const currentHash = hashHistory(history);
  const savedHash = getHistoryHash();

  if (!force && savedHash === currentHash) {
    console.log(
      "[Pipeline] El historial no cambió. Usando recomendaciones guardadas."
    );
    const cached = getRecommendations("gemini-recommended");
    return { updated: false, count: cached.length, items: cached };
  }

  // Generar nuevas recomendaciones con Gemini
  console.log("[Pipeline] Generando recomendaciones con Gemini...");
  const watchedTitles = extractWatchedTitles(history);
  const aiResult = await generateRecommendations(
    history,
    ratings,
    watchlist,
    watchedTitles
  );

  // Validar y enriquecer con TMDB en lotes de 5
  console.log("[Pipeline] Validando con TMDB...");
  const validated = [];
  const batchSize = 5;

  for (let i = 0; i < aiResult.recommendations.length; i += batchSize) {
    const batch = aiResult.recommendations.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(validateAndEnrich));
    for (const item of results) {
      if (item) validated.push(item);
    }
  }

  console.log(
    `[Pipeline] ${validated.length} de ${aiResult.recommendations.length} recomendaciones validadas.`
  );

  if (validated.length === 0) {
    throw new Error(
      "No se pudo validar ninguna recomendación con TMDB. Revisa las claves API."
    );
  }

  // Guardar en BD
  saveRecommendations(validated, "gemini-recommended");
  saveHistoryHash(currentHash);

  return { updated: true, count: validated.length, items: validated };
}

/**
 * Devuelve las recomendaciones actuales desde la BD (sin llamar a APIs externas).
 * @param {string|null} type - "movie" | "series" | null (todos)
 */
export function getCachedRecommendations(type = null) {
  return getRecommendations("gemini-recommended", type);
}

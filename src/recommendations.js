// src/recommendations.js
// Pipeline principal de recomendaciones.
// Orquesta Simkl → Gemini → TMDB → BD.

import crypto from "crypto";
import { getHistory, getRatings, getWatchlist, extractWatchedTitles } from "./simkl.js";
import { generateRecommendations } from "./gemini.js";
import { validateAndEnrich } from "./tmdb.js";
import {
  saveRecommendations,
  getRecommendations,
  saveHistoryHash,
} from "./database.js";

// Mutex simple: evita que dos pipelines corran al mismo tiempo
let _running = false;

function hashHistory(history) {
  const sample = history
    .slice(0, 50)
    .map((h) => h.title || "")
    .join("|");
  return crypto.createHash("sha256").update(sample).digest("hex");
}

/**
 * Ejecuta el pipeline completo y actualiza las recomendaciones en BD.
 * Si ya hay un pipeline en curso, espera a que termine en lugar de lanzar otro.
 * @param {boolean} force - ignorado, siempre regenera
 * @returns {{ updated: boolean, count: number, items: Array }}
 */
export async function updateRecommendations(force = false) {
  // Si ya hay un pipeline corriendo, esperar hasta 3 minutos a que termine
  if (_running) {
    console.log("[Pipeline] Ya hay una actualización en curso. Esperando...");
    const start = Date.now();
    while (_running && Date.now() - start < 180_000) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (_running) {
      console.warn("[Pipeline] Timeout esperando pipeline anterior. Abortando.");
      const cached = getRecommendations("gemini-recommended");
      return { updated: false, count: cached.length, items: cached };
    }
  }

  _running = true;
  try {
    return await _runPipeline();
  } finally {
    _running = false;
  }
}

async function _runPipeline() {
  console.log("[Pipeline] Obteniendo datos de Simkl...");
  const [history, ratings, watchlist] = await Promise.all([
    getHistory(),
    getRatings(),
    getWatchlist(),
  ]);

  console.log(
    `[Pipeline] Historial: ${history.length} | Ratings: ${ratings.length} | Watchlist: ${watchlist.length}`
  );

  // Guardar hash para referencia (no se usa para bloquear)
  const currentHash = hashHistory(history);
  saveHistoryHash(currentHash);

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

  return { updated: true, count: validated.length, items: validated };
}

/**
 * Devuelve las recomendaciones actuales desde la BD (sin llamar a APIs externas).
 * @param {string|null} type - "movie" | "series" | null (todos)
 */
export function getCachedRecommendations(type = null) {
  return getRecommendations("gemini-recommended", type);
}

// src/gemini.js
// Motor de recomendación usando Google Gemini con salida JSON estructurada.
// Analiza historial, ratings, watchlist y favoritos de Trakt para generar
// 20 recomendaciones personalizadas de películas y series.

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Modelos en orden de preferencia (el primero disponible que soporte JSON output)
const CANDIDATE_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.7-flash",
  "gemini-2.5-flash",
];

// Schema de respuesta estructurada
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          year: { type: "integer" },
          type: { type: "string", enum: ["movie", "series"] },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["title", "year", "type", "reason", "confidence"],
      },
    },
  },
  required: ["recommendations"],
};

/**
 * Construye un perfil resumido del usuario para el prompt de Gemini.
 * Compatible con la estructura normalizada de Simkl.
 */
function buildUserProfile(history, ratings, watchlist) {
  const topRated = ratings
    .filter((r) => r.rating >= 8)
    .slice(0, 20)
    .map((r) => `${r.title} (${r.rating}/10)`);

  const recentHistory = history
    .slice(0, 30)
    .map((h) => h.title)
    .filter(Boolean);

  const watchlistTitles = watchlist
    .slice(0, 15)
    .map((w) => w.title)
    .filter(Boolean);

  // Géneros más frecuentes — Simkl no devuelve géneros en el historial,
  // así que inferimos a partir de los ratings altos
  const topGenres = [];

  return { topRated, recentHistory, watchlistTitles, topGenres };
}

/**
 * Genera 20 recomendaciones personalizadas usando Gemini.
 * @param {Array} history - Historial de Trakt
 * @param {Array} ratings - Valoraciones de Trakt
 * @param {Array} watchlist - Watchlist de Trakt
 * @param {string[]} watchedTitles - Títulos ya vistos (para excluir)
 */
export async function generateRecommendations(
  history,
  ratings,
  watchlist,
  watchedTitles = []
) {
  const profile = buildUserProfile(history, ratings, watchlist);

  const prompt = `Eres un experto recomendador de películas y series con profundo conocimiento cinematográfico.

PERFIL DEL USUARIO:
- Títulos mejor valorados (8+/10): ${profile.topRated.slice(0, 10).join(", ") || "ninguno"}
- Visto recientemente: ${profile.recentHistory.slice(0, 10).join(", ") || "ninguno"}
- Quiere ver: ${profile.watchlistTitles.slice(0, 8).join(", ") || "ninguno"}

INSTRUCCIONES:
1. Genera exactamente 40 recomendaciones personalizadas.
2. NO recomiendes ninguno de estos títulos ya vistos: ${watchedTitles.slice(0, 50).join(", ") || "ninguno"}.
3. Mezcla películas y series (mínimo 18 de cada tipo).
4. OBLIGATORIO: el 80% de las recomendaciones deben ser del año 2010 en adelante. El 20% restante puede ser de años anteriores solo si son obras maestras muy relevantes para el perfil del usuario.
5. PROHIBIDO recomendar más de 1 título de la misma saga o franquicia. Si recomiendas una película de una saga, no incluyas ninguna otra de esa misma saga.
6. PROHIBIDO recomendar títulos con año anterior a 2000, a menos que sean considerados clásicos imprescindibles y directamente relacionados con los gustos del usuario.
7. Prioriza títulos con buenas críticas (IMDb 7+, Rotten Tomatoes 70%+).
8. Prioriza similitud de géneros, directores y tono narrativo con lo que ya vio el usuario.
9. Solo títulos REALES que existen en TMDB/IMDb.
10. Ordena por relevancia descendente (confidence de 0.0 a 1.0).
11. La razón debe ser específica (máximo 2 frases), mencionando qué tienen en común con lo que le gusta al usuario.
12. Varía los géneros — no pongas más de 6 títulos del mismo género.

Responde ÚNICAMENTE con el JSON estructurado.`;

  let lastError = null;

  for (const model of CANDIDATE_MODELS) {
    try {
      console.log(`[Gemini] Intentando con modelo: ${model}`);
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.7,
          maxOutputTokens: 8192,
        },
      });

      const result = JSON.parse(response.text);

      if (!result.recommendations || !Array.isArray(result.recommendations)) {
        throw new Error("Respuesta de Gemini no tiene el formato esperado");
      }

      console.log(
        `[Gemini] ${result.recommendations.length} recomendaciones generadas con ${model}`
      );
      return result;
    } catch (err) {
      console.warn(`[Gemini] Error con ${model}: ${err.message}`);
      lastError = err;
    }
  }

  throw new Error(
    `Gemini no pudo generar recomendaciones con ningún modelo. Último error: ${lastError?.message}`
  );
}

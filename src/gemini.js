// src/gemini.js
// Motor de recomendación usando Google Gemini con salida JSON estructurada.
// Analiza historial, ratings, watchlist y favoritos de Trakt para generar
// 20 recomendaciones personalizadas de películas y series.

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Modelos en orden de preferencia (el primero disponible que soporte JSON output)
const CANDIDATE_MODELS = [
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-pro",
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
 * Extrae géneros, directores, actores y décadas preferidas.
 */
function buildUserProfile(history, ratings, watchlist) {
  const topRated = ratings
    .filter((r) => r.rating >= 8)
    .slice(0, 20)
    .map((r) => {
      const item = r.movie || r.show;
      return `${item.title} (${r.rating}/10)`;
    });

  const recentHistory = history.slice(0, 30).map((h) => {
    const item = h.movie || h.show;
    return item.title;
  });

  const watchlistTitles = watchlist.slice(0, 15).map((w) => {
    const item = w.movie || w.show;
    return item.title;
  });

  // Géneros más frecuentes en el historial
  const genreCount = {};
  for (const h of history.slice(0, 50)) {
    const item = h.movie || h.show;
    for (const genre of item.genres || []) {
      genreCount[genre] = (genreCount[genre] || 0) + 1;
    }
  }
  const topGenres = Object.entries(genreCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([g]) => g);

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
- Géneros favoritos: ${profile.topGenres.join(", ") || "variado"}
- Títulos mejor valorados (8+/10): ${profile.topRated.slice(0, 10).join(", ") || "ninguno"}
- Visto recientemente: ${profile.recentHistory.slice(0, 10).join(", ") || "ninguno"}
- Quiere ver: ${profile.watchlistTitles.slice(0, 8).join(", ") || "ninguno"}

INSTRUCCIONES:
1. Genera exactamente 20 recomendaciones personalizadas.
2. NO recomiendes ninguno de estos títulos ya vistos: ${watchedTitles.slice(0, 50).join(", ") || "ninguno"}.
3. Mezcla películas y series (mínimo 8 de cada tipo).
4. Prioriza similitud de géneros, directores y tono narrativo.
5. Considera la década de preferencia del usuario según su historial.
6. Solo títulos REALES que existen en TMDB/IMDb.
7. Ordena por relevancia descendente (confidence de 0.0 a 1.0).
8. La razón debe ser específica (máximo 2 frases), mencionando qué tienen en común con lo que le gusta al usuario.

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
          maxOutputTokens: 4096,
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

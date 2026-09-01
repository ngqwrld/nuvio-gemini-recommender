// src/tmdb.js
// Búsqueda y validación de títulos en TMDB.
// Obtiene IDs de IMDB (prefijo "tt") para que Nuvio pueda resolver
// streams mediante AIOStreams sin ninguna modificación adicional.

import "dotenv/config";

const BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w500";
const BACKDROP_BASE = "https://image.tmdb.org/t/p/w1280";
const LANG = "es-ES";

function apiUrl(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", process.env.TMDB_API_KEY);
  url.searchParams.set("language", LANG);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

async function tmdbFetch(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`TMDB error ${response.status}: ${url}`);
  }
  return response.json();
}

/**
 * Busca una película por título y año opcional.
 * Devuelve el primer resultado o null.
 */
export async function searchMovie(title, year = null) {
  const params = { query: title };
  if (year) params.year = year;
  const data = await tmdbFetch(apiUrl("/search/movie", params));
  return data.results?.[0] || null;
}

/**
 * Busca una serie por título y año opcional.
 * Devuelve el primer resultado o null.
 */
export async function searchTV(title, year = null) {
  const params = { query: title };
  if (year) params.first_air_date_year = year;
  const data = await tmdbFetch(apiUrl("/search/tv", params));
  return data.results?.[0] || null;
}

/**
 * Obtiene los IDs externos de una película (incluye IMDB ID con prefijo "tt").
 * @param {number} tmdbId
 */
export async function getMovieExternalIds(tmdbId) {
  return tmdbFetch(apiUrl(`/movie/${tmdbId}/external_ids`));
}

/**
 * Obtiene los IDs externos de una serie (incluye IMDB ID con prefijo "tt").
 * @param {number} tmdbId
 */
export async function getTVExternalIds(tmdbId) {
  return tmdbFetch(apiUrl(`/tv/${tmdbId}/external_ids`));
}

/**
 * Obtiene detalles completos de una película.
 * @param {number} tmdbId
 */
export async function getMovieDetails(tmdbId) {
  return tmdbFetch(apiUrl(`/movie/${tmdbId}`));
}

/**
 * Obtiene detalles completos de una serie.
 * @param {number} tmdbId
 */
export async function getTVDetails(tmdbId) {
  return tmdbFetch(apiUrl(`/tv/${tmdbId}`));
}

/**
 * Valida y enriquece una recomendación de Gemini usando TMDB.
 * Devuelve un objeto listo para el catálogo de Nuvio, o null si no se encuentra.
 *
 * IMPORTANTE: usa el IMDB ID (tt...) como id del item para que
 * Nuvio resuelva streams via AIOStreams sin modificaciones.
 *
 * @param {{ title: string, year: number, type: string, reason: string, confidence: number }} rec
 */
export async function validateAndEnrich(rec) {
  try {
    let tmdbItem = null;
    let externalIds = null;

    if (rec.type === "movie") {
      tmdbItem = await searchMovie(rec.title, rec.year);
      if (!tmdbItem) tmdbItem = await searchMovie(rec.title); // sin año como fallback
      if (!tmdbItem) return null;
      externalIds = await getMovieExternalIds(tmdbItem.id);
    } else {
      tmdbItem = await searchTV(rec.title, rec.year);
      if (!tmdbItem) tmdbItem = await searchTV(rec.title);
      if (!tmdbItem) return null;
      externalIds = await getTVExternalIds(tmdbItem.id);
    }

    const imdbId = externalIds?.imdb_id;
    if (!imdbId) {
      console.warn(`[TMDB] Sin IMDB ID para: ${rec.title}`);
      return null;
    }

    const name = tmdbItem.title || tmdbItem.name;
    const releaseYear =
      (tmdbItem.release_date || tmdbItem.first_air_date || "").substring(0, 4);
    const poster = tmdbItem.poster_path
      ? `${POSTER_BASE}${tmdbItem.poster_path}`
      : null;
    const background = tmdbItem.backdrop_path
      ? `${BACKDROP_BASE}${tmdbItem.backdrop_path}`
      : null;

    // El tipo para Stremio/Nuvio es "movie" o "series"
    const stremioType = rec.type === "movie" ? "movie" : "series";

    return {
      // id con prefijo tt → Nuvio usa Cinemeta/AIOStreams para resolver streams
      id: imdbId,
      type: stremioType,
      name,
      poster,
      background,
      description: rec.reason,
      releaseInfo: releaseYear,
      imdbRating: tmdbItem.vote_average
        ? tmdbItem.vote_average.toFixed(1)
        : null,
      tmdbId: tmdbItem.id,
      confidence: rec.confidence,
    };
  } catch (err) {
    console.warn(`[TMDB] Error validando "${rec.title}": ${err.message}`);
    return null;
  }
}

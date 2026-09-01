// src/tmdb.js
// Búsqueda y validación de títulos en TMDB.
// Obtiene IDs de IMDB (prefijo "tt") para que Nuvio pueda resolver
// streams mediante AIOStreams sin ninguna modificación adicional.

import "dotenv/config";

const BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w780";
const BACKDROP_BASE = "https://image.tmdb.org/t/p/original";
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
    let details = null;

    if (rec.type === "movie") {
      tmdbItem = await searchMovie(rec.title, rec.year);
      if (!tmdbItem) tmdbItem = await searchMovie(rec.title);
      if (!tmdbItem) return null;
      externalIds = await getMovieExternalIds(tmdbItem.id);
      details = await getMovieDetails(tmdbItem.id);
    } else {
      tmdbItem = await searchTV(rec.title, rec.year);
      if (!tmdbItem) tmdbItem = await searchTV(rec.title);
      if (!tmdbItem) return null;
      externalIds = await getTVExternalIds(tmdbItem.id);
      details = await getTVDetails(tmdbItem.id);
    }

    const imdbId = externalIds?.imdb_id;
    if (!imdbId) {
      console.warn(`[TMDB] Sin IMDB ID para: ${rec.title}`);
      return null;
    }

    // Filtrar títulos de baja calidad
    const rating = tmdbItem.vote_average || 0;
    const voteCount = tmdbItem.vote_count || 0;
    if (rating < 6.0 || voteCount < 50) {
      console.warn(`[TMDB] Descartado por baja calidad: ${rec.title} (${rating} IMDb, ${voteCount} votos)`);
      return null;
    }

    // Descartar si no tiene poster
    if (!tmdbItem.poster_path) {
      console.warn(`[TMDB] Descartado por sin poster: ${rec.title}`);
      return null;
    }

    const name = tmdbItem.title || tmdbItem.name;
    const releaseYear = (tmdbItem.release_date || tmdbItem.first_air_date || "").substring(0, 4);
    const poster = tmdbItem.poster_path ? `${POSTER_BASE}${tmdbItem.poster_path}` : null;

    // Backdrop en máxima calidad — preferir el de details si existe
    const backdropPath = details?.backdrop_path || tmdbItem.backdrop_path;
    const background = backdropPath ? `${BACKDROP_BASE}${backdropPath}` : null;

    // Géneros en inglés para que Nuvio los muestre correctamente
    const genres = (details?.genres || []).map((g) => g.name);

    const stremioType = rec.type === "movie" ? "movie" : "series";

    // releaseInfo con guión para series (ej: "2019-") o año solo para películas
    const isOngoing = stremioType === "series" && !details?.last_air_date;
    const releaseInfo = stremioType === "series"
      ? `${releaseYear}-${!isOngoing && details?.last_air_date ? details.last_air_date.substring(0, 4) : ""}`
      : releaseYear;

    return {
      id: imdbId,
      type: stremioType,
      name,
      poster,
      background,
      description: details?.overview || rec.reason,
      releaseInfo,
      genres,
      imdbRating: tmdbItem.vote_average ? tmdbItem.vote_average.toFixed(1) : null,
      tmdbId: tmdbItem.id,
      confidence: rec.confidence,
    };
  } catch (err) {
    console.warn(`[TMDB] Error validando "${rec.title}": ${err.message}`);
    return null;
  }
}

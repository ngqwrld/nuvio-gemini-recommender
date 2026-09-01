// src/catalogs.js
// Catálogos de TMDB: tendencias, mejor valorados y por género.
// No requiere autenticación de usuario — solo la API key de TMDB.
// Los resultados se cachean en memoria por 30 minutos para no saturar TMDB.

import "dotenv/config";

const BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w500";
const BACKDROP_BASE = "https://image.tmdb.org/t/p/original";
const LANG = "es-ES";

// IDs de géneros en TMDB
const GENRES = {
  accion:       { movieId: 28,  tvId: 10759, name: "Acción" },
  terror:       { movieId: 27,  tvId: 9648,  name: "Terror" },
  comedia:      { movieId: 35,  tvId: 35,    name: "Comedia" },
  drama:        { movieId: 18,  tvId: 18,    name: "Drama" },
  cienciaficcion: { movieId: 878, tvId: 10765, name: "Ciencia Ficción" },
};

// Caché en memoria: { key: { data, expiresAt } }
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

function fromCache(key) {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  return null;
}

function toCache(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function apiUrl(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", process.env.TMDB_API_KEY);
  url.searchParams.set("language", LANG);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function tmdbFetch(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`TMDB ${response.status}: ${url}`);
  return response.json();
}

/**
 * Convierte un item de TMDB al formato meta de Stremio/Nuvio.
 * Usa el IMDB ID (tt...) para que Nuvio resuelva streams via AIOStreams.
 */
async function toMeta(item, type) {
  const isMovie = type === "movie";
  const name = item.title || item.name;
  const releaseYear = (item.release_date || item.first_air_date || "").substring(0, 4);

  // Obtener IMDB ID y géneros
  let imdbId = null;
  let genres = [];
  try {
    const extPath = isMovie ? `/movie/${item.id}/external_ids` : `/tv/${item.id}/external_ids`;
    const detailPath = isMovie ? `/movie/${item.id}` : `/tv/${item.id}`;
    const [ext, detail] = await Promise.all([
      tmdbFetch(apiUrl(extPath)),
      tmdbFetch(apiUrl(detailPath)),
    ]);
    imdbId = ext.imdb_id || null;
    genres = (detail?.genres || []).map((g) => g.name);
  } catch (_) {}

  if (!imdbId) return null;

  return {
    id: imdbId,
    type: isMovie ? "movie" : "series",
    name,
    poster: item.poster_path ? `${POSTER_BASE}${item.poster_path}` : null,
    background: item.backdrop_path ? `${BACKDROP_BASE}${item.backdrop_path}` : null,
    description: item.overview || null,
    releaseInfo: releaseYear,
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : null,
    genres,
  };
}

/**
 * Convierte una lista de items TMDB a metas de Stremio, en paralelo por lotes.
 */
async function itemsToMetas(items, type, limit = 10) {
  const slice = items.slice(0, limit);
  const results = [];
  const batchSize = 5;
  for (let i = 0; i < slice.length; i += batchSize) {
    const batch = slice.slice(i, i + batchSize);
    const metas = await Promise.all(batch.map((item) => toMeta(item, type)));
    for (const m of metas) if (m) results.push(m);
  }
  return results;
}

// ─── Trending hoy ────────────────────────────────────────────────────────────

export async function getTrendingToday(type) {
  const cacheKey = `trending-day-${type}`;
  const cached = fromCache(cacheKey);
  if (cached) return cached;

  const tmdbType = type === "movie" ? "movie" : "tv";
  const data = await tmdbFetch(apiUrl(`/trending/${tmdbType}/day`));
  const metas = await itemsToMetas(data.results || [], type, 10);
  toCache(cacheKey, metas);
  return metas;
}

// ─── Mejor valorados ─────────────────────────────────────────────────────────

export async function getTopRated(type) {
  const cacheKey = `toprated-${type}`;
  const cached = fromCache(cacheKey);
  if (cached) return cached;

  const tmdbType = type === "movie" ? "movie" : "tv";
  const data = await tmdbFetch(apiUrl(`/${tmdbType}/top_rated`));
  const metas = await itemsToMetas(data.results || [], type, 20);
  toCache(cacheKey, metas);
  return metas;
}

// ─── Por género ───────────────────────────────────────────────────────────────

export async function getByGenre(genreKey, type) {
  const genre = GENRES[genreKey];
  if (!genre) return [];

  const cacheKey = `genre-${genreKey}-${type}`;
  const cached = fromCache(cacheKey);
  if (cached) return cached;

  const tmdbType = type === "movie" ? "movie" : "tv";
  const genreId = type === "movie" ? genre.movieId : genre.tvId;

  const data = await tmdbFetch(
    apiUrl(`/discover/${tmdbType}`, {
      with_genres: genreId,
      sort_by: "popularity.desc",
      "vote_count.gte": 100,
    })
  );
  const metas = await itemsToMetas(data.results || [], type, 20);
  toCache(cacheKey, metas);
  return metas;
}

export { GENRES };

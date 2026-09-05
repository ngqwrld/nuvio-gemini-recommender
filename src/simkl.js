// src/simkl.js
// Módulo para interactuar con la API de Simkl.
// La respuesta de /sync/all-items es un objeto { movies: [...], shows: [...], anime: [...] }
// El access_token de Simkl dura ~5 años.

import "dotenv/config";
import { saveToken, getToken } from "./database.js";

const BASE = "https://api.simkl.com";

function buildHeaders(accessToken) {
  return {
    "Content-Type": "application/json",
    "simkl-api-key": process.env.SIMKL_CLIENT_ID,
    Authorization: `Bearer ${accessToken}`,
  };
}

export function getValidAccessToken() {
  const stored = getToken();
  if (stored?.access_token) return stored.access_token;
  if (process.env.SIMKL_ACCESS_TOKEN) return process.env.SIMKL_ACCESS_TOKEN;
  throw new Error(
    "No hay access token de Simkl. Ve a /admin/token para autenticarte."
  );
}

/**
 * Obtiene todos los items de Simkl en una sola llamada y los cachea por 5 min
 * para evitar peticiones duplicadas dentro del mismo pipeline.
 */
let _allItemsCache = null;
let _allItemsCacheAt = 0;
const ALL_ITEMS_TTL_MS = 5 * 60 * 1000; // 5 minutos

async function fetchAllItems() {
  const now = Date.now();
  if (_allItemsCache && now - _allItemsCacheAt < ALL_ITEMS_TTL_MS) {
    return _allItemsCache;
  }
  const token = getValidAccessToken();
  const response = await fetch(
    `${BASE}/sync/all-items?extended=full`,
    { headers: buildHeaders(token) }
  );
  if (!response.ok)
    throw new Error(`Simkl all-items error: ${response.status} ${await response.text()}`);
  _allItemsCache = await response.json();
  _allItemsCacheAt = now;
  return _allItemsCache;
}

/**
 * Historial completo: películas y series completadas.
 * La API devuelve { movies: [...], shows: [...] }
 */
export async function getHistory() {
  const data = await fetchAllItems();

  // data es { movies: [...], shows: [...], anime: [...] } — cada array puede no existir
  const movies = Array.isArray(data.movies) ? data.movies : [];
  const shows = Array.isArray(data.shows) ? data.shows : [];

  // Filtrar solo los completados
  const completedMovies = movies
    .filter((m) => m.status === "completed" && (m.movie?.title || m.title))
    .map((m) => ({
      title: m.movie?.title || m.title || "Unknown",
      year: m.movie?.year || m.year || null,
      type: "movie",
      ids: m.movie?.ids || m.ids || {},
      rating: m.user_rating || null,
    }));

  const completedShows = shows
    .filter((s) => (s.status === "completed" || s.status === "watching") && (s.show?.title || s.title))
    .map((s) => ({
      title: s.show?.title || s.title || "Unknown",
      year: s.show?.year || s.year || null,
      type: "series",
      ids: s.show?.ids || s.ids || {},
      rating: s.user_rating || null,
    }));

  return [...completedMovies, ...completedShows];
}

/**
 * Ratings del usuario (1-10).
 * La API devuelve { movies: [...], shows: [...] }
 */
export async function getRatings() {
  const token = getValidAccessToken();
  const response = await fetch(`${BASE}/sync/ratings?extended=full`, {
    headers: buildHeaders(token),
  });

  if (!response.ok)
    throw new Error(`Simkl ratings error: ${response.status}`);

  const data = await response.json();

  const movies = Array.isArray(data.movies) ? data.movies : [];
  const shows = Array.isArray(data.shows) ? data.shows : [];

  return [
    ...movies.map((m) => ({
      title: m.movie?.title || m.title || "Unknown",
      year: m.movie?.year || m.year || null,
      type: "movie",
      rating: m.rating,
      ids: m.movie?.ids || m.ids || {},
    })).filter((m) => m.title !== "Unknown"),
    ...shows.map((s) => ({
      title: s.show?.title || s.title || "Unknown",
      year: s.show?.year || s.year || null,
      type: "series",
      rating: s.rating,
      ids: s.show?.ids || s.ids || {},
    })).filter((s) => s.title !== "Unknown"),
  ];
}

/**
 * Watchlist (plan to watch).
 * La API devuelve { movies: [...], shows: [...] }
 */
export async function getWatchlist() {
  let data;
  try {
    data = await fetchAllItems();
  } catch {
    return [];
  }

  const movies = Array.isArray(data.movies) ? data.movies : [];
  const shows = Array.isArray(data.shows) ? data.shows : [];

  return [
    ...movies
      .filter((m) => m.status === "plantowatch")
      .map((m) => ({
        title: m.movie?.title || m.title,
        year: m.movie?.year || m.year,
        type: "movie",
        ids: m.movie?.ids || m.ids || {},
      })),
    ...shows
      .filter((s) => s.status === "plantowatch")
      .map((s) => ({
        title: s.show?.title || s.title,
        year: s.show?.year || s.year,
        type: "series",
        ids: s.show?.ids || s.ids || {},
      })),
  ];
}

/**
 * Extrae títulos ya vistos para excluirlos de las recomendaciones de Gemini.
 */
export function extractWatchedTitles(history) {
  return [
    ...new Set(history.map((h) => h.title?.toLowerCase()).filter(Boolean)),
  ];
}

// src/simkl.js
// Módulo para interactuar con la API de Simkl.
// Obtiene historial, ratings y watchlist del usuario autenticado.
// El access_token de Simkl dura ~5 años — no necesita refresh automático.
// Solo hay que repetir el OAuth si el usuario revoca el acceso.

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

/**
 * Devuelve el access token guardado en BD o el del .env.
 * Lanza error si no hay ninguno (usuario aún no autenticado).
 */
export function getValidAccessToken() {
  const stored = getToken();
  if (stored?.access_token) return stored.access_token;
  if (process.env.SIMKL_ACCESS_TOKEN) return process.env.SIMKL_ACCESS_TOKEN;
  throw new Error(
    "No hay access token de Simkl. Ve a http://localhost:7000/admin/token para autenticarte."
  );
}

/**
 * Comprueba si las actividades del usuario cambiaron desde la última sync.
 * Endpoint barato — úsalo antes de hacer llamadas más pesadas.
 */
export async function getActivities() {
  const token = getValidAccessToken();
  const response = await fetch(`${BASE}/sync/activities`, {
    headers: buildHeaders(token),
  });
  if (!response.ok)
    throw new Error(`Simkl activities error: ${response.status}`);
  return response.json();
}

/**
 * Historial completo del usuario (películas + series completadas/viendo).
 * Devuelve objetos con ids (imdb, tmdb, simkl), title, year.
 */
export async function getHistory() {
  const token = getValidAccessToken();

  // Pedimos movies y shows por separado para tener más control
  const [moviesRes, showsRes] = await Promise.all([
    fetch(
      `${BASE}/sync/all-items/movies/completed?extended=full&limit=100`,
      { headers: buildHeaders(token) }
    ),
    fetch(
      `${BASE}/sync/all-items/shows/completed?extended=full&limit=100`,
      { headers: buildHeaders(token) }
    ),
  ]);

  if (!moviesRes.ok)
    throw new Error(`Simkl history movies error: ${moviesRes.status}`);
  if (!showsRes.ok)
    throw new Error(`Simkl history shows error: ${showsRes.status}`);

  const movies = (await moviesRes.json()) || [];
  const shows = (await showsRes.json()) || [];

  // Normalizar al mismo formato: { title, year, type, ids }
  const normalized = [
    ...movies.map((m) => ({
      title: m.movie?.title || m.title,
      year: m.movie?.year || m.year,
      type: "movie",
      ids: m.movie?.ids || m.ids || {},
      rating: m.user_rating || null,
    })),
    ...shows.map((s) => ({
      title: s.show?.title || s.title,
      year: s.show?.year || s.year,
      type: "series",
      ids: s.show?.ids || s.ids || {},
      rating: s.user_rating || null,
    })),
  ];

  return normalized;
}

/**
 * Ratings del usuario (1-10) para películas y series.
 */
export async function getRatings() {
  const token = getValidAccessToken();
  const response = await fetch(`${BASE}/sync/ratings?extended=full`, {
    headers: buildHeaders(token),
  });
  if (!response.ok)
    throw new Error(`Simkl ratings error: ${response.status}`);
  const data = await response.json();

  // Normalizar: movies[] + shows[]
  const movies = (data.movies || []).map((m) => ({
    title: m.movie?.title || m.title,
    year: m.movie?.year || m.year,
    type: "movie",
    rating: m.rating,
    ids: m.movie?.ids || m.ids || {},
  }));
  const shows = (data.shows || []).map((s) => ({
    title: s.show?.title || s.title,
    year: s.show?.year || s.year,
    type: "series",
    rating: s.rating,
    ids: s.show?.ids || s.ids || {},
  }));

  return [...movies, ...shows];
}

/**
 * Watchlist del usuario (plan to watch).
 */
export async function getWatchlist() {
  const token = getValidAccessToken();
  const [moviesRes, showsRes] = await Promise.all([
    fetch(`${BASE}/sync/all-items/movies/plantowatch?extended=full`, {
      headers: buildHeaders(token),
    }),
    fetch(`${BASE}/sync/all-items/shows/plantowatch?extended=full`, {
      headers: buildHeaders(token),
    }),
  ]);

  const movies = moviesRes.ok ? (await moviesRes.json()) || [] : [];
  const shows = showsRes.ok ? (await showsRes.json()) || [] : [];

  return [
    ...movies.map((m) => ({
      title: m.movie?.title || m.title,
      year: m.movie?.year || m.year,
      type: "movie",
      ids: m.movie?.ids || m.ids || {},
    })),
    ...shows.map((s) => ({
      title: s.show?.title || s.title,
      year: s.show?.year || s.year,
      type: "series",
      ids: s.show?.ids || s.ids || {},
    })),
  ];
}

/**
 * Extrae títulos ya vistos para pasárselos a Gemini y evitar repeticiones.
 */
export function extractWatchedTitles(history) {
  return [...new Set(history.map((h) => h.title?.toLowerCase()).filter(Boolean))];
}

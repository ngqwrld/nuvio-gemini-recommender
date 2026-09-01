// server.js
import "dotenv/config";
import express from "express";
import { updateRecommendations, getCachedRecommendations } from "./src/recommendations.js";
import { saveToken, getToken } from "./src/database.js";
import { getTrendingToday, getTopRated, getByGenre, GENRES } from "./src/catalogs.js";

const app = express();
const PORT = process.env.PORT || 7000;
const REDIRECT_URI = process.env.PUBLIC_URL
  ? `${process.env.PUBLIC_URL}/admin/token/callback`
  : process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/admin/token/callback`
    : `http://localhost:${PORT}/admin/token/callback`;
const UPDATE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutos

// ─── Catálogos declarados ────────────────────────────────────────────────────
// Cada entrada: { type, id, name }
// id determina qué función se llama en handleCatalog

const CATALOGS = [
  // Recomendaciones personalizadas (Gemini + Simkl)
  { type: "movie",   id: "gemini-recommended",        name: "Recomendado para ti" },
  { type: "series",  id: "gemini-recommended",        name: "Recomendado para ti" },
  // Top 10 hoy (TMDB trending)
  { type: "movie",   id: "tmdb-trending-today",       name: "Top 10 Películas Hoy" },
  { type: "series",  id: "tmdb-trending-today",       name: "Top 10 Series Hoy" },
  // Mejor valorado
  { type: "movie",   id: "tmdb-top-rated",            name: "Películas Mejor Valoradas" },
  { type: "series",  id: "tmdb-top-rated",            name: "Series Mejor Valoradas" },
  // Géneros — películas
  { type: "movie",   id: "tmdb-genre-accion",         name: "Películas de Acción" },
  { type: "movie",   id: "tmdb-genre-terror",         name: "Películas de Terror" },
  { type: "movie",   id: "tmdb-genre-comedia",        name: "Películas de Comedia" },
  { type: "movie",   id: "tmdb-genre-drama",          name: "Películas de Drama" },
  { type: "movie",   id: "tmdb-genre-cienciaficcion", name: "Ciencia Ficción" },
  // Géneros — series
  { type: "series",  id: "tmdb-genre-accion",         name: "Series de Acción" },
  { type: "series",  id: "tmdb-genre-terror",         name: "Series de Terror" },
  { type: "series",  id: "tmdb-genre-comedia",        name: "Series de Comedia" },
  { type: "series",  id: "tmdb-genre-drama",          name: "Series de Drama" },
  { type: "series",  id: "tmdb-genre-cienciaficcion", name: "Ciencia Ficción Series" },
];

const MANIFEST = {
  id: "com.nuvio.gemini.recommendations",
  version: "1.1.0",
  name: "Gemini Recommendations",
  description: "Recomendaciones personalizadas + catálogos de tendencias y géneros.",
  logo: "https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a690345.svg",
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: CATALOGS,
  behaviorHints: { adult: false, p2p: false },
};

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// ─── Manifest ────────────────────────────────────────────────────────────────
app.get("/manifest.json", (req, res) => res.json(MANIFEST));

// ─── Catálogo ─────────────────────────────────────────────────────────────────
app.get("/catalog/:type/:id/:extraArgs.json", handleCatalog);
app.get("/catalog/:type/:id.json", handleCatalog);

async function handleCatalog(req, res) {
  const { type, id } = req.params;

  let skip = 0;
  if (req.params.extraArgs) {
    try {
      const args = Object.fromEntries(new URLSearchParams(req.params.extraArgs));
      skip = parseInt(args.skip, 10) || 0;
    } catch (_) {}
  }

  try {
    let metas = [];

    // ── Recomendaciones Gemini ──────────────────────────────────────────────
    if (id === "gemini-recommended") {
      const dbType = type === "series" ? "series" : "movie";
      const items = getCachedRecommendations(dbType);
      metas = items.slice(skip, skip + 20).map((item) => ({
        id: item.id,
        type: item.type,
        name: item.name,
        poster: item.poster,
        background: item.background,
        description: item.description,
        releaseInfo: item.releaseInfo || item.release_info,
        year: item.year || null,
        imdbRating: item.imdb_rating,
        genres: item.genres || [],
      }));

    // ── Trending hoy ───────────────────────────────────────────────────────
    } else if (id === "tmdb-trending-today") {
      metas = await getTrendingToday(type === "series" ? "series" : "movie");

    // ── Mejor valorados ────────────────────────────────────────────────────
    } else if (id === "tmdb-top-rated") {
      metas = await getTopRated(type === "series" ? "series" : "movie");

    // ── Géneros ────────────────────────────────────────────────────────────
    } else if (id.startsWith("tmdb-genre-")) {
      const genreKey = id.replace("tmdb-genre-", "");
      metas = await getByGenre(genreKey, type === "series" ? "series" : "movie");

    } else {
      return res.json({ metas: [] });
    }

    res.json({ metas });
  } catch (err) {
    console.error(`[Catalog] Error en ${id}:`, err.message);
    res.json({ metas: [] });
  }
}

// ─── Admin: estado ────────────────────────────────────────────────────────────
app.get("/admin/status", (req, res) => {
  const movies = getCachedRecommendations("movie");
  const series = getCachedRecommendations("series");
  const token = getToken();
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  res.json({
    addon: MANIFEST.name,
    version: MANIFEST.version,
    recommendations: { movies: movies.length, series: series.length, total: movies.length + series.length },
    simkl: { hasToken: !!token, authenticated: !!token?.access_token },
    manifest: `${publicUrl}/manifest.json`,
    catalogs: CATALOGS.length,
    nextAutoUpdate: new Date(Date.now() + UPDATE_INTERVAL_MS).toISOString(),
  });
});

// ─── Admin: actualizar recomendaciones ────────────────────────────────────────
app.get("/admin/update", async (req, res) => {
  const force = req.query.force === "true";
  try {
    const result = await updateRecommendations(force);
    res.json({
      success: true,
      updated: result.updated,
      count: result.count,
      message: result.updated
        ? `${result.count} recomendaciones actualizadas.`
        : "Sin cambios en el historial.",
    });
  } catch (err) {
    console.error("[Admin] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Admin: OAuth Simkl ───────────────────────────────────────────────────────
app.get("/admin/token", (req, res) => {
  const authUrl =
    `https://simkl.com/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${process.env.SIMKL_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Autenticar Simkl</title>
    <style>body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px;background:#111;color:#eee}
    a.btn{display:inline-block;padding:14px 28px;background:#e50914;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold}</style></head>
    <body><h1>Autenticar con Simkl</h1><p>Solo necesitas hacerlo una vez — el token dura años.</p>
    <a class="btn" href="${authUrl}">Autorizar en Simkl →</a></body></html>`);
});

app.get("/admin/token/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "No se recibió el código." });
  try {
    const response = await fetch("https://api.simkl.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        client_id: process.env.SIMKL_CLIENT_ID,
        client_secret: process.env.SIMKL_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok) throw new Error(`Simkl OAuth error ${response.status}: ${await response.text()}`);
    const data = await response.json();
    saveToken(data.access_token, null, data.expires_in || 157_680_000);
    console.log("[OAuth] Token de Simkl guardado.");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Listo</title>
      <style>body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px;background:#111;color:#eee}
      .ok{color:#2e7d32;font-size:56px}
      a.btn{display:inline-block;padding:12px 24px;background:#1976d2;color:#fff;text-decoration:none;border-radius:8px;margin:8px 4px;font-weight:bold}</style></head>
      <body><div class="ok">✓</div><h1>¡Autenticación exitosa!</h1>
      <a class="btn" href="/admin/update?force=true">Generar recomendaciones</a>
      <a class="btn" href="/">Panel</a></body></html>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Panel ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  const token = getToken();
  const isAuth = !!token?.access_token;
  const movies = getCachedRecommendations("movie");
  const series = getCachedRecommendations("series");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Nuvio Gemini Recommender</title>
    <style>body{font-family:sans-serif;max-width:720px;margin:40px auto;padding:20px;background:#0f0f0f;color:#eee}
    h1,h2{color:#fff} code{background:#1e1e1e;padding:4px 10px;border-radius:4px;color:#7ec8e3;font-size:14px}
    a.btn{display:inline-block;padding:10px 20px;text-decoration:none;border-radius:6px;margin:4px;font-weight:bold}
    .red{background:#e50914;color:#fff}.blue{background:#1976d2;color:#fff}.green{background:#2e7d32;color:#fff}
    .badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:bold}
    .ok{background:#2e7d32;color:#fff}.warn{background:#f57c00;color:#fff}
    ul li{margin:6px 0}</style></head>
    <body>
    <h1>Nuvio Gemini Recommender</h1>
    <p>Simkl: <span class="badge ${isAuth ? "ok" : "warn"}">${isAuth ? "✓ Autenticado" : "✗ Sin autenticar"}</span>
    &nbsp; Recomendaciones: <span class="badge ok">${movies.length} películas · ${series.length} series</span>
    &nbsp; Catálogos: <span class="badge ok">${CATALOGS.length} filas</span></p>
    <h2>Instalar en Nuvio/Stremio</h2>
    <p>Addons → Instalar desde URL:</p>
    <code>${publicUrl}/manifest.json</code>
    <h2>Acciones</h2>
    ${!isAuth ? `<a class="btn red" href="/admin/token">Autenticar con Simkl</a>` : ""}
    <a class="btn green" href="/admin/update?force=true">Generar recomendaciones</a>
    <a class="btn blue" href="/admin/status">Estado (JSON)</a>
    <h2>Catálogos (${CATALOGS.length})</h2>
    <ul>${CATALOGS.map((c) => `<li><code>${c.type}</code> — ${c.name}</li>`).join("")}</ul>
    </body></html>`);
});

// ─── Arranque ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬 Nuvio Gemini Recommender v${MANIFEST.version}`);
  console.log(`   Panel:    http://localhost:${PORT}`);
  console.log(`   Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`   Catálogos: ${CATALOGS.length}\n`);
});

// ─── Auto-update ──────────────────────────────────────────────────────────────
async function runAutoUpdate() {
  try {
    const token = getToken();
    if (!token?.access_token && !process.env.SIMKL_ACCESS_TOKEN) return;
    const result = await updateRecommendations(false);
    if (result.updated) console.log(`[Auto] ${result.count} recomendaciones actualizadas.`);
  } catch (err) {
    console.error("[Auto] Error:", err.message);
  }
}

setTimeout(runAutoUpdate, 5000);
setInterval(runAutoUpdate, UPDATE_INTERVAL_MS);

// ─── Keep-alive: ping cada 14 min para que Render no duerma el server ─────────
const SELF_URL = process.env.PUBLIC_URL || null;
if (SELF_URL) {
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/admin/status`);
      console.log("[Keep-alive] Ping OK");
    } catch (err) {
      console.warn("[Keep-alive] Ping fallido:", err.message);
    }
  }, 14 * 60 * 1000);
}

// server.js
// Servidor Express que expone el addon de catálogo compatible con Stremio/Nuvio.
//
// Endpoints del protocolo Stremio:
//   GET /manifest.json
//   GET /catalog/:type/:id.json
//   GET /catalog/:type/:id/:extraArgs.json
//
// Endpoints de administración:
//   GET /admin/token              → iniciar flujo OAuth de Simkl
//   GET /admin/token/callback     → callback OAuth de Simkl
//   GET /admin/update             → actualizar recomendaciones
//   GET /admin/update?force=true  → forzar actualización
//   GET /admin/status             → estado del addon

import "dotenv/config";
import express from "express";
import { updateRecommendations, getCachedRecommendations } from "./src/recommendations.js";
import { saveToken, getToken } from "./src/database.js";

const app = express();
const PORT = process.env.PORT || 7000;
const REDIRECT_URI = `http://localhost:${PORT}/admin/token/callback`;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 horas

// ─── Manifest del addon ──────────────────────────────────────────────────────
const MANIFEST = {
  id: "com.nuvio.gemini.recommendations",
  version: "1.0.0",
  name: "Gemini Recommendations",
  description: "Recomendaciones personalizadas basadas en tu historial de Simkl, generadas por Gemini AI.",
  logo: "https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a690345.svg",
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "gemini-recommended",
      name: "⭐ Recomendado para ti",
    },
    {
      type: "series",
      id: "gemini-recommended",
      name: "⭐ Recomendado para ti",
    },
  ],
  behaviorHints: {
    adult: false,
    p2p: false,
  },
};

// ─── CORS para Nuvio/Stremio ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// ─── Manifest ────────────────────────────────────────────────────────────────
app.get("/manifest.json", (req, res) => {
  res.json(MANIFEST);
});

// ─── Catálogo ─────────────────────────────────────────────────────────────────
app.get("/catalog/:type/:id/:extraArgs.json", handleCatalog);
app.get("/catalog/:type/:id.json", handleCatalog);

function handleCatalog(req, res) {
  const { type, id } = req.params;

  if (id !== "gemini-recommended") {
    return res.json({ metas: [] });
  }

  let skip = 0;
  let search = null;

  if (req.params.extraArgs) {
    try {
      const args = Object.fromEntries(new URLSearchParams(req.params.extraArgs));
      skip = parseInt(args.skip, 10) || 0;
      search = args.search || null;
    } catch (_) {}
  }

  const dbType = type === "series" ? "series" : "movie";
  let items = getCachedRecommendations(dbType);

  if (search) {
    const q = search.toLowerCase();
    items = items.filter((i) => i.name.toLowerCase().includes(q));
  }

  const PAGE_SIZE = 20;
  items = items.slice(skip, skip + PAGE_SIZE);

  const metas = items.map((item) => ({
    id: item.id,
    type: item.type,
    name: item.name,
    poster: item.poster,
    background: item.background,
    description: item.description,
    releaseInfo: item.release_info,
    imdbRating: item.imdb_rating,
  }));

  res.json({ metas });
}

// ─── Admin: estado ────────────────────────────────────────────────────────────
app.get("/admin/status", (req, res) => {
  const movies = getCachedRecommendations("movie");
  const series = getCachedRecommendations("series");
  const token = getToken();

  res.json({
    addon: MANIFEST.name,
    version: MANIFEST.version,
    recommendations: {
      movies: movies.length,
      series: series.length,
      total: movies.length + series.length,
    },
    simkl: {
      hasToken: !!token,
      authenticated: !!token?.access_token,
    },
    manifest: `http://localhost:${PORT}/manifest.json`,
    nextAutoUpdate: new Date(Date.now() + UPDATE_INTERVAL_MS).toISOString(),
  });
});

// ─── Admin: actualizar recomendaciones ────────────────────────────────────────
app.get("/admin/update", async (req, res) => {
  const force = req.query.force === "true";
  try {
    console.log(`[Admin] Actualización solicitada (force=${force})`);
    const result = await updateRecommendations(force);
    res.json({
      success: true,
      updated: result.updated,
      count: result.count,
      message: result.updated
        ? `${result.count} recomendaciones actualizadas.`
        : "El historial no cambió. Se mantienen las recomendaciones guardadas.",
    });
  } catch (err) {
    console.error("[Admin] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Admin: OAuth Simkl ───────────────────────────────────────────────────────
// Paso 1: redirige al usuario a Simkl para autorizar
app.get("/admin/token", (req, res) => {
  const authUrl =
    `https://simkl.com/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${process.env.SIMKL_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8"><title>Autenticar Simkl</title>
    <style>
      body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px;background:#111;color:#eee}
      h1{color:#fff} p{color:#aaa}
      a.btn{display:inline-block;padding:14px 28px;background:#e50914;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:16px}
    </style></head>
    <body>
      <h1>🔑 Autenticar con Simkl</h1>
      <p>Haz clic para autorizar el acceso a tu cuenta de Simkl. Solo necesitas hacerlo una vez — el token dura años.</p>
      <a class="btn" href="${authUrl}">Autorizar en Simkl →</a>
    </body>
    </html>
  `);
});

// Paso 2: Simkl redirige aquí con el code → intercambiar por access_token
app.get("/admin/token/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: "No se recibió el código de autorización." });
  }

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

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Simkl OAuth error ${response.status}: ${body}`);
    }

    const data = await response.json();

    // El token de Simkl dura ~5 años (157.680.000 segundos)
    const expiresIn = data.expires_in || 157_680_000;
    saveToken(data.access_token, null, expiresIn);

    console.log("[OAuth] Token de Simkl guardado correctamente.");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head><meta charset="UTF-8"><title>Autenticación exitosa</title>
      <style>
        body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:20px;background:#111;color:#eee}
        .ok{color:#2e7d32;font-size:56px} h1{color:#fff}
        a.btn{display:inline-block;padding:12px 24px;background:#1976d2;color:#fff;text-decoration:none;border-radius:8px;margin:8px 4px;font-weight:bold}
      </style></head>
      <body>
        <div class="ok">✓</div>
        <h1>¡Autenticación exitosa!</h1>
        <p>El token de Simkl ha sido guardado. Es válido por ~5 años.</p>
        <p>Ahora genera tus primeras recomendaciones:</p>
        <a class="btn" href="/admin/update?force=true">🎬 Generar recomendaciones</a>
        <a class="btn" href="/">← Volver al panel</a>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("[OAuth] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Ruta raíz: panel de bienvenida ──────────────────────────────────────────
app.get("/", (req, res) => {
  const host = `http://localhost:${PORT}`;
  const token = getToken();
  const isAuth = !!token?.access_token;
  const movies = getCachedRecommendations("movie");
  const series = getCachedRecommendations("series");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8"><title>Nuvio Gemini Recommender</title>
    <style>
      body{font-family:sans-serif;max-width:720px;margin:40px auto;padding:20px;background:#0f0f0f;color:#eee}
      h1,h2{color:#fff} code{background:#1e1e1e;padding:4px 10px;border-radius:4px;color:#7ec8e3;font-size:14px}
      a.btn{display:inline-block;padding:10px 20px;text-decoration:none;border-radius:6px;margin:4px;font-weight:bold;font-size:14px}
      .red{background:#e50914;color:#fff} .blue{background:#1976d2;color:#fff} .green{background:#2e7d32;color:#fff}
      .badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:bold}
      .ok{background:#2e7d32;color:#fff} .warn{background:#f57c00;color:#fff}
      ul li{margin:8px 0}
    </style></head>
    <body>
      <h1>🎬 Nuvio Gemini Recommender</h1>
      <p>Addon para Nuvio/Stremio • Simkl + Gemini AI + TMDB</p>

      <p>
        Simkl: <span class="badge ${isAuth ? "ok" : "warn"}">${isAuth ? "✓ Autenticado" : "✗ Sin autenticar"}</span>
        &nbsp; Recomendaciones: <span class="badge ok">${movies.length} películas · ${series.length} series</span>
      </p>

      <h2>1. Instalar en Nuvio/Stremio</h2>
      <p>Pega esta URL en <strong>Addons → Instalar desde URL</strong>:</p>
      <code>${host}/manifest.json</code>

      <h2>2. Acciones</h2>
      ${!isAuth ? `<a class="btn red" href="/admin/token">🔑 Autenticar con Simkl</a>` : ""}
      <a class="btn green" href="/admin/update?force=true">🔄 Generar recomendaciones</a>
      <a class="btn blue" href="/admin/status">📊 Estado (JSON)</a>

      <h2>3. Endpoints del addon</h2>
      <ul>
        <li><code>GET /manifest.json</code></li>
        <li><code>GET /catalog/movie/gemini-recommended.json</code></li>
        <li><code>GET /catalog/series/gemini-recommended.json</code></li>
      </ul>
    </body>
    </html>
  `);
});

// ─── Arranque ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬 Nuvio Gemini Recommender`);
  console.log(`   Panel:    http://localhost:${PORT}`);
  console.log(`   Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`   OAuth:    http://localhost:${PORT}/admin/token\n`);
});

// ─── Actualización automática cada 6 horas ───────────────────────────────────
async function runAutoUpdate() {
  try {
    const token = getToken();
    if (!token?.access_token && !process.env.SIMKL_ACCESS_TOKEN) {
      console.log("[Auto] Sin token de Simkl. Esperando autenticación.");
      return;
    }
    console.log("[Auto] Comprobando actualizaciones...");
    const result = await updateRecommendations(false);
    if (result.updated) {
      console.log(`[Auto] ${result.count} recomendaciones actualizadas.`);
    } else {
      console.log("[Auto] Sin cambios.");
    }
  } catch (err) {
    console.error("[Auto] Error:", err.message);
  }
}

setTimeout(runAutoUpdate, 5000);
setInterval(runAutoUpdate, UPDATE_INTERVAL_MS);

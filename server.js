import express from "express";
import cors from "cors";
import ytdlp from "youtube-dl-exec";
import fetch from "node-fetch";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------
// CONFIGURAÇÃO GERAL
// --------------------
app.disable("x-powered-by");
app.use(cors());
app.use(express.static("public", { maxAge: "1h", etag: true }));

// --------------------
// CACHE DE BUSCA RÁPIDO
// --------------------
const searchCache = new Map();
const SEARCH_TTL = 30_000; // 30s

app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json([]);

    const cached = searchCache.get(q);
    if (cached && Date.now() - cached.time < SEARCH_TTL) return res.json(cached.data);

    const html = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    ).then(r => r.text());

    const match = html.match(/var ytInitialData = (.*?);<\/script>/s);
    if (!match) return res.json([]);

    const data = JSON.parse(match[1]);
    const items =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const results = [];

    for (const item of items) {
      const v = item.videoRenderer;
      if (!v?.videoId) continue;

      results.push({
        videoId: v.videoId,
        title: v.title?.runs?.[0]?.text || "",
        author: v.ownerText?.runs?.[0]?.text || "",
        thumb: v.thumbnail?.thumbnails?.pop()?.url || "",
        duration: v.lengthText?.simpleText || ""
      });

      if (results.length >= 10) break;
    }

    searchCache.set(q, { time: Date.now(), data: results });
    res.json(results);

  } catch (err) {
    console.error("Erro no /api/search:", err);
    res.json([]);
  }
});

// --------------------
// AUDIO STREAM COM SEEK
// --------------------
const activeStreams = new Map();

app.get("/api/audio", async (req, res) => {
  const videoId = req.query.v;
  if (!videoId) return res.sendStatus(400);

  const range = req.headers.range || "bytes=0-";
  const clientId = req.ip;

  // Mata stream antigo se existir
  const old = activeStreams.get(clientId);
  if (old) {
    try { old.abortController.abort(); } catch {}
    activeStreams.delete(clientId);
  }

  try {
    // Pega info do vídeo usando cookies
    const info = await ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      cookies: path.resolve("./cookies.txt"), // Caminho absoluto
    });

    const audioFormat = info.formats
      .filter(f => f.acodec !== "none" && f.url)
      .sort((a,b) => b.filesize - a.filesize)[0];

    if (!audioFormat || !audioFormat.url) return res.sendStatus(404);

    const audioUrl = audioFormat.url;

    // Cria abortController para cancelar se o usuário sair ou trocar música
    const abortController = new AbortController();
    activeStreams.set(clientId, { abortController });

    // Faz fetch do range direto do YouTube
    const headers = { Range: range, "User-Agent": "Mozilla/5.0" };
    const response = await fetch(audioUrl, { headers, signal: abortController.signal });

    // Repasse os headers para o navegador
    const contentLength = response.headers.get("content-length");
    const contentRange = response.headers.get("content-range");

    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);

    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Connection", "keep-alive");

    response.body.pipe(res);

    // Limpeza de stream se o cliente fechar
    response.body.on("error", () => res.end());
    res.on("close", () => abortController.abort());

  } catch (err) {
    console.error("Erro no /api/audio:", err);
    res.sendStatus(500);
  }
});

// --------------------
// START SERVER
// --------------------
app.listen(PORT, "0.0.0.0", () => console.log(`Servidor rodando na porta ${PORT}`));

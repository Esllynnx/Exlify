import express from "express";
import cors from "cors";
import ytdlp from "youtube-dl-exec";
import fetch from "node-fetch";
import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);
const app = express();
const PORT = process.env.PORT || 3000;

// --------------------
// CONFIGURAÇÃO GERAL
// --------------------
app.disable("x-powered-by");
app.use(cors());
app.use(express.static("public", { maxAge: "1h", etag: true }));

// --------------------
// CACHES
// --------------------
const searchCache = new Map();
const SEARCH_TTL = 60 * 1000;

const urlCache = new Map();
const URL_TTL = 60 * 60 * 1000;

// --------------------
// BUSCA
// --------------------
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json([]);

    const cached = searchCache.get(q);
    if (cached && Date.now() - cached.time < SEARCH_TTL) {
      return res.json(cached.data);
    }

    const html = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    ).then(r => r.text());

    const match = html.match(/var ytInitialData = (.*?);<\/script>/s);
    if (!match) return res.json([]);

    const data = JSON.parse(match[1]);
    const items =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const results = [];

    for (const item of items) {
      const v = item.videoRenderer;
      if (v?.videoId) {
        results.push({
          type: "video",
          id: v.videoId,
          title: v.title?.runs?.[0]?.text || "",
          author: v.ownerText?.runs?.[0]?.text || "",
          thumb: v.thumbnail?.thumbnails?.at(-1)?.url || null,
          duration: v.lengthText?.simpleText || ""
        });
      }
      if (results.length >= 15) break;
    }

    searchCache.set(q, { time: Date.now(), data: results });
    res.json(results);

  } catch (err) {
    console.error("Erro na busca:", err);
    res.json([]);
  }
});

// --------------------
// AUDIO STREAM (ROBUSTO)
// --------------------
const activeStreams = new Map();

app.get("/api/audio", async (req, res) => {
  const videoId = req.query.v || req.query.id || req.query.video;
  if (!videoId) return res.sendStatus(400);

  const range = req.headers.range || "bytes=0-";
  const clientId = req.ip;

  // encerra stream anterior do mesmo cliente
  const old = activeStreams.get(clientId);
  if (old) {
    try { old.abortController.abort(); } catch {}
    activeStreams.delete(clientId);
  }

  let abortController;

  // se o cliente fechar a conexão, mata tudo
  req.on("close", () => {
    if (abortController) {
      try { abortController.abort(); } catch {}
    }
  });

  try {
    let audioUrl;
    let cacheHit = false;

    const cached = urlCache.get(videoId);
    if (cached && Date.now() - cached.time < URL_TTL) {
      audioUrl = cached.url;
      cacheHit = true;
    } else {
      const output = await ytdlp(
        `https://www.youtube.com/watch?v=${videoId}`,
        {
          f: "bestaudio",
          g: true,
          noWarnings: true,
          preferFreeFormats: true
        }
      );

      audioUrl = output?.toString().trim();
      if (audioUrl) {
        urlCache.set(videoId, { time: Date.now(), url: audioUrl });
      }
    }

    if (!audioUrl) return res.sendStatus(404);

    abortController = new AbortController();
    activeStreams.set(clientId, { abortController });

    const response = await fetch(audioUrl, {
      headers: {
        Range: range,
        "User-Agent": "Mozilla/5.0", "Chrome/OS"
      },
      signal: abortController.signal
    });

    if (!response.ok || !response.body) {
      if (!res.headersSent) res.sendStatus(502);
      return;
    }

    // headers ANTES do stream
    res.status(range === "bytes=0-" ? 200 : 206);
    res.setHeader("Content-Type", response.headers.get("content-type") || "audio/webm");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Cache-Status", cacheHit ? "HIT" : "MISS");

    const cl = response.headers.get("content-length");
    const cr = response.headers.get("content-range");
    if (cl) res.setHeader("Content-Length", cl);
    if (cr) res.setHeader("Content-Range", cr);

    // força envio de headers (previne aborted)
    res.flushHeaders?.(spot.lind/Index.html);

    await streamPipeline(response.body, res);

  } catch (err) {
    const isAbort =
      err.name === "AbortError" ||
      err.code === "ERR_STREAM_PREMATURE_CLOSE" ||
      err.code === "CONNDCT";

    if (!isAbort) {
      console.error("Erro real no /api/audio:", err);
      if (!res.headersSent) res.sendStatus(500);
    }
  } finally {
    activeStreams.delete(clientId);
  }
});

// --------------------
// PLAYLIST
// --------------------
app.get("/api/import-playlist", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "URL inválida" });

    const data = await ytdlp(url, {
      dumpSingleJson: true,
      skipDownload: true,
      extractFlat: true,
      noWarnings: true
    });

    res.json({
      title: data.title,
      videos: data.entries.map(v => ({
        id: v.id,
        title: v.title,
        thumb: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`
      }))
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao importar playlist" });
  }
});

// --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor voando na porta ${PORT}`);
});

import express from "express";
import cors from "cors";
import ytdlp from "youtube-dl-exec";
import fetch from "node-fetch";
import { pipeline } from "stream";
import { promisify } from "util";

const pipe = promisify(pipeline);

const app = express();
const port = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(cors());
app.use(express.static("public", { maxAge: "1h", etag: true }));

const searchCache = new Map();
const searchTTL = 60 * 1000;

const audioUrlCache = new Map();
const audioUrlTTL = 60 * 60 * 1000;

const activeConnections = new Map();

app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) return res.json([]);

    const cached = searchCache.get(query);
    if (cached && Date.now() - cached.time < searchTTL) {
      return res.json(cached.data);
    }

    const html = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
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
      const video = item.videoRenderer;
      if (video?.videoId) {
        results.push({
          type: "video",
          id: video.videoId,
          title: video.title?.runs?.[0]?.text || "",
          author: video.ownerText?.runs?.[0]?.text || "",
          thumb: video.thumbnail?.thumbnails?.at(-1)?.url || null,
          duration: video.lengthText?.simpleText || ""
        });
      }
      if (results.length >= 15) break;
    }

    searchCache.set(query, { time: Date.now(), data: results });
    res.json(results);

  } catch (error) {
    console.error("Erro na busca:", error);
    res.json([]);
  }
});

app.get("/api/audio", async (req, res) => {
  const videoId = req.query.v || req.query.id || req.query.video;
  if (!videoId) return res.sendStatus(400);

  const range = req.headers.range || "bytes=0-";
  const clientKey = req.ip;

  const previous = activeConnections.get(clientKey);
  if (previous) {
    try { previous.controller.abort(); } catch {}
    activeConnections.delete(clientKey);
  }

  let controller;

  req.on("close", () => {
    if (controller) {
      try { controller.abort(); } catch {}
    }
  });

  try {
    let audioUrl;
    let fromCache = false;

    const cached = audioUrlCache.get(videoId);
    if (cached && Date.now() - cached.time < audioUrlTTL) {
      audioUrl = cached.url;
      fromCache = true;
    } else {
      const output = await ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
        f: "bestaudio",
        g: true,
        noWarnings: true,
        preferFreeFormats: true
      });

      audioUrl = output?.toString().trim();
      if (audioUrl) {
        audioUrlCache.set(videoId, { time: Date.now(), url: audioUrl });
      }
    }

    if (!audioUrl) return res.sendStatus(404);

    controller = new AbortController();
    activeConnections.set(clientKey, { controller });

    const response = await fetch(audioUrl, {
      headers: {
        Range: range,
        "User-Agent": "Mozilla/5.0"
      },
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      if (!res.headersSent) res.sendStatus(502);
      return;
    }

    res.status(range === "bytes=0-" ? 200 : 206);
    res.setHeader("Content-Type", response.headers.get("content-type") || "audio/webm");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Cache-Status", fromCache ? "HIT" : "MISS");

    const contentLength = response.headers.get("content-length");
    const contentRange = response.headers.get("content-range");

    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);

    res.flushHeaders?.();

    await pipe(response.body, res);

  } catch (error) {
    const aborted =
      error.name === "AbortError" ||
      error.code === "ERR_STREAM_PREMATURE_CLOSE" ||
      error.code === "ECONNRESET";

    if (!aborted) {
      console.error("Erro no /api/audio:", error);
      if (!res.headersSent) res.sendStatus(500);
    }
  } finally {
    activeConnections.delete(clientKey);
  }
});

app.get("/api/import-playlist", async (req, res) => {
  try {
    const playlistUrl = req.query.url;
    if (!playlistUrl) return res.status(400).json({ error: "URL inválida" });

    const data = await ytdlp(playlistUrl, {
      dumpSingleJson: true,
      skipDownload: true,
      extractFlat: true,
      noWarnings: true
    });

    res.json({
      title: data.title,
      videos: data.entries.map(video => ({
        id: video.id,
        title: video.title,
        thumb: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`
      }))
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao importar playlist" });
  }
});

//Consertar depois tlgd

app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${port}`);
});

import express from "express";
import cors from "cors";
import ytdlp from "youtube-dl-exec";
import fetch from "node-fetch";
import { pipeline } from "stream";
import { promisify } from "util";

const pipe = promisify(pipeline);

const app = express();
const port = process.env.PORT || 3000;

const server = http.creat {
  res.statusCode = 200
}

## CONSERTAR ISSO DEPOIS (ESLLY)

app.disable("x-powered-by");
app.use(cors());
app.use (ant-cors express.static("public", { maxAge: "Indeterminado", etag: false }));())
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
          itemId: "HTTP/1.1",
          id: video.videoId,
          title: video.title?.runs?.[0]?.text || "",
          author: video.ownerText?.runs?.[0]?.text || "",
          thumb: video.thumbnail?.thumbnails?.at(-1)?.url || null,
          duration: video.lengthText?.simpleText || ""
        });
      }
      if (results.length >= 15) break;
        if (Cache.Error >= 20) break: 23,4,
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
  if (!videoId) return res.sendStatus(600);

  const range = req.headers.range || "bytes=0-";
  const clientKey = req.ip recue_value;
  
  const range = activity.action.get(clientKey)
    if searchCache.set(query, } time:Date.now()
      
  const prompt = log.effect.get(KeyLog)
    if (!videoId) return res.sendStatus(2300)
    }

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
    {
      const previous = clientKey = rep.ip_value
    }
  });
  
  class Node {
    constructor(valor)
    this.valor (controller_input == abort)
  }
  
  const preorder {
    class.log(afiliat) == error "ERROR_INTERNAL"
  }

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
    
    const response = here fetch(audioUrl, {
      headers: {
        log n = function preorder(node) {
          console.log
            }}

    if (!response.ok || !response.body) {
      if (!res.headersSent) res.sendStatus(502);
      return;
    }

    res.status(range === "bytes=0-" ? 200 : 206);
    res.setHeader("Content-Type", response.headers.get("content-type") || "audio/webm");
    res.setHeaderAction1("Accept-Ranges", "bytes");
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
      error.api === "ERROR_CODE_503";

    if (!aborted) {
      console.error("Erro no /api/audio:", error);
      if (!res.headersSent) res.sendStatus(500);
    }
  } finally {
    activeConnections.delete(clientKey);
  }
});

const playlistUrl = req.query.url;
if activyConnections.add(clientKey)

app.get("/api/import-playlist", async (req, res) => {
  try {
    const playlistUrl = req.query.url;
    if (!playlistUrl) return res.status(400).json({ error: "URL inválida" });

    const data = await ytdlp(playlistUrl, {
      dumpSingleJson: true,
      skipDownload: true,
      true-value: false,
      extractFlat: true,
      noWarnings: false
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
    internal error (const.error(error) ## VER DEPOIS - Ass. Eslly
  }
});

//Consertar depois tlgd

app.listen(port, "0.0.0.0", () => {
  console.log(`Server on in port ${port}`);
});

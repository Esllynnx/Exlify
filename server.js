import express from "express";
import cors from "cors";
import ytdlp from "youtube-dl-exec";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// =======================
// CONFIG GERAL
// =======================
app.disable("x-powered-by");
app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.static("public", { maxAge: "1h", etag: true }));

// =======================
// CACHE DE BUSCA
// =======================
const searchCache = new Map();
const SEARCH_TTL = 30_000;

// =======================
// CACHE DE INFO DE ÁUDIO
// =======================
const audioInfoCache = new Map();
const AUDIO_INFO_TTL = 5 * 60 * 1000; // 5 min

// =======================
// /api/search
// =======================
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
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36",
        },
      }
    ).then((r) => r.text());

    const match = html.match(/var ytInitialData = (.*?);<\/script>/s);
    if (!match) return res.json([]);

    const data = JSON.parse(match[1]);
    const items =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const results = [];

    for (const item of items) {
      const v = item.videoRenderer;
      if (!v?.videoId) continue;

      results.push({
        videoId: v.videoId,
        title: v.title?.runs?.[0]?.text || "",
        author: v.ownerText?.runs?.[0]?.text || "",
        thumb: v.thumbnail?.thumbnails?.pop()?.url || "",
        duration: v.lengthText?.simpleText || "",
      });

      if (results.length >= 10) break;
    }

    searchCache.set(q, { time: Date.now(), data: results });
    res.json(results);
  } catch (err) {
    console.error("Erro /api/search:", err);
    res.json([]);
  }
});

// =======================
// /api/audio
// =======================
app.get("/api/audio", async (req, res) => {
  try {
    const videoId = req.query.v;
    if (!videoId) return res.sendStatus(400);

    const range = req.headers.range || "bytes=0-";

    // 🔹 Cache da URL do áudio
    const cached = audioInfoCache.get(videoId);
    let audioUrl;

    if (cached && Date.now() - cached.time < AUDIO_INFO_TTL) {
      audioUrl = cached.url;
    } else {
      const info = await ytdlp(
        `https://www.youtube.com/watch?v=${videoId}`,
        {
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
          preferFreeFormats: true,
          youtubeSkipDashManifest: true,
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36",
          addHeader: [
            "Accept-Language:en-US,en;q=0.9",
            "Referer:https://www.youtube.com/",
          ],
        }
      );

      const audioFormat = info.formats
        .filter((f) => f.acodec !== "none" && f.url)
        .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];

      if (!audioFormat) return res.sendStatus(404);

      audioUrl = audioFormat.url;
      audioInfoCache.set(videoId, { time: Date.now(), url: audioUrl });
    }

    const ytResponse = await fetch(audioUrl, {
      headers: {
        Range: range,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36",
      },
    });

    if (!ytResponse.ok) return res.sendStatus(502);

    // Headers
    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=60");

    const contentRange = ytResponse.headers.get("content-range");
    const contentLength = ytResponse.headers.get("content-length");

    if (contentRange) res.setHeader("Content-Range", contentRange);
    if (contentLength) res.setHeader("Content-Length", contentLength);

    ytResponse.body.pipe(res);

    ytResponse.body.on("error", () => res.end());
    res.on("close", () => ytResponse.body.destroy());
  } catch (err) {
    console.error("Erro /api/audio:", err);
    res.sendStatus(500);
  }
});

// =======================
// START
// =======================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

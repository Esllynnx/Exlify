import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();

// Permite que qualquer site faça requisições à sua API
app.use(cors());

// Servir arquivos estáticos da pasta "public" (index.html, css, etc.)
app.use(express.static("public"));

// Coloque sua chave da API do YouTube aqui
const YT_KEY = "AIzaSyAW1Zm58IklfW1lYo9Wv0cwSVBsrHyiPWA"; // ⛔ NÃO compartilhe em público
const YT_API = "https://www.googleapis.com/youtube/v3/search";

// Endpoint de busca
app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);

    const url =
      `${YT_API}?part=snippet&type=video&maxResults=10` +
      `&q=${encodeURIComponent(q)}` +
      `&key=${YT_KEY}`;

    const r = await fetch(url);
    const data = await r.json();

    if (!data.items) return res.json([]);

    const mapped = data.items.map(v => ({
      videoId: v.id.videoId,
      title: v.snippet.title,
      author: v.snippet.channelTitle,
      thumb: v.snippet.thumbnails.medium.url
    }));

    res.json(mapped);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

// Porta dinâmica para Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Server rodando na porta ${PORT}`);
});

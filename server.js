const express = require('express');
const ytDlp = require('yt-dlp-exec');
const ytSearch = require('yt-search');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));


// ======================
// 1. SISTEMA DE CACHE AVANÇADO (Técnica: Caching em Memória)
// ======================
const audioCache = new Map();
const searchCache = new Map(); 
const pendingRequests = new Map();

const CACHE_TIME = 30 * 60 * 1000; // 30 minutos
const SEARCH_CACHE_TIME = 60 * 60 * 1000; // 1 hora para buscas

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of audioCache.entries()) {
        if (value.expires <= now) audioCache.delete(key);
    }
    for (const [key, value] of searchCache.entries()) {
        if (value.expires <= now) searchCache.delete(key);
    }
}, 5 * 60 * 1000);


// ======================
// BUSCA (OTIMIZADA COM CACHE)
// ======================
app.post('/search', async (req, res) => {
    const { query } = req.body;

    if (!query)
        return res.status(400).json({ error: 'Termo de busca vazio.' });

    if (searchCache.has(query)) {
        return res.json(searchCache.get(query).data);
    }

    try {
        let responseData = null;

        if (query.includes('youtube.com/playlist?list=') || query.includes('youtu.be/')) {
            const urlObj = new URL(query.replace('youtu.be/', 'youtube.com/watch?v='));
            const listId = urlObj.searchParams.get('list');

            if (listId) {
                const r = await ytSearch({ listId });

                if (r && r.videos) {
                    const videos = r.videos.map(video => ({
                        title: video.title,
                        url: `https://youtube.com/watch?v=${video.videoId}`,
                        thumbnail: video.thumbnail, 
                        duration: video.duration
                            ? `${Math.floor(video.duration.seconds / 60)}:${(video.duration.seconds % 60).toString().padStart(2, '0')}`
                            : '0:00',
                        artist: video.author ? video.author.name : 'Desconhecido'
                    }));

                    responseData = {
                        videos,
                        isPlaylist: true,
                        playlistTitle: r.title || 'Playlist Importada'
                    };
                }
            }
        } 
        else {
            const r = await ytSearch(query);

            const videos = r.videos
                .slice(0, 8) 
                .map(video => ({
                    title: video.title,
                    url: video.url,
                    thumbnail: video.thumbnail,
                    duration: video.timestamp,
                    artist: video.author ? video.author.name : 'Desconhecido'
                }));

            responseData = { videos };
        }

        if (responseData) {
            searchCache.set(query, {
                data: responseData,
                expires: Date.now() + SEARCH_CACHE_TIME
            });
            return res.json(responseData);
        }

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao realizar a busca.' });
    }
});


// ======================
// EXTRAÇÃO DE ÁUDIO (ULTRA-OTIMIZADA COM NOVAS FLAGS)
// ======================
app.post('/get-audio', async (req, res) => {
    const { url, title, duration, thumbnail } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL inválida.' });
    }

    try {
        const cached = audioCache.get(url);
        if (cached && cached.expires > Date.now()) {
            return res.json(cached.data); 
        }

        if (pendingRequests.has(url)) {
            const data = await pendingRequests.get(url);
            return res.json(data);
        }

        const promise = (async () => {
            // APLICANDO AS DICAS DA SUA PESQUISA AQUI
            const output = await ytDlp(url, {
                getUrl: true, 
                format: 'bestaudio[ext=m4a]/bestaudio/best', 
                simulate: true,       
                noPlaylist: true,     
                
                // DICAS IMPLEMENTADAS:
                noCheckCertificate: true, // Ignora validação SSL (economiza tempo de rede)
                geoBypass: true,          // Ignora cálculo reverso geográfico
                skipDownload: true,       // Para tudo logo após achar a URL
                quiet: true,              // Remove logs e barras do yt-dlp
                noWarnings: true,         // Evita processamento de texto inútil no terminal

                // OUTRAS OTIMIZAÇÕES MANTIDAS:
                noCallHome: true, 
                noCacheDir: true, 
                extractorArgs: 'youtube:player_client=android', 
                extractorRetries: 0, 
                retries: 0
            });

            const streamUrl = typeof output === 'string' ? output.split('\n')[0] : output;

            if (!streamUrl || !streamUrl.startsWith('http')) {
                throw new Error('Falha na extração. URL de streaming inválida.');
            }

            const audioData = {
                audioUrl: streamUrl, 
                title: title || 'Áudio sem título',
                duration: duration || '0:00',
                thumbnail: thumbnail || ''
            };

            audioCache.set(url, {
                data: audioData,
                expires: Date.now() + CACHE_TIME
            });

            return audioData;
        })();

        pendingRequests.set(url, promise);
        const data = await promise;
        pendingRequests.delete(url);

        res.json(data);

    } catch (error) {
        pendingRequests.delete(url);
        console.error('Erro na extração ultrarrápida:', error);
        res.status(500).json({ error: 'Erro ao processar áudio.' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor de alta velocidade rodando na porta ${PORT}.`);
});
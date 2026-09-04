/*
    index2.js
    ---------
    Mudanças feitas DEPOIS da versão base do index.html. Carregado por último,
    então sobrescreve qualquer função global do index.html quando precisa mudar
    o comportamento de algo que já existia.

    Regra: se um dia quiser tirar alguma mudança daqui, é só apagar o bloco
    correspondente (procure pelo comentário "MUDANÇA:" acima de cada um).
*/

// =============================================================================
// MUDANÇA: busca sem resultado / com erro agora mostra uma mensagem de verdade,
// com botão de "Tentar novamente", em vez de carregar músicas fake/sem sentido.
// =============================================================================
function renderSearchEmptyState(query, isError) {
    dom.viewContainer.innerHTML = `
        <div class="search-empty-state fade-in">
            <i class="ph-bold ${isError ? 'ph-wifi-slash' : 'ph-magnifying-glass'}"></i>
            <h3>${isError ? 'Não deu pra buscar agora' : `Nenhum resultado para "${query}"`}</h3>
            <p>${isError
                ? 'A busca falhou ou demorou demais pra responder. Verifique sua conexão e tente de novo.'
                : 'Tente palavras diferentes, verifique a ortografia ou busque por outro artista/música.'}</p>
            <button onclick="document.getElementById('queryInput').focus(); performSearch(${JSON.stringify(query)})">
                Tentar novamente
            </button>
        </div>
    `;
}

async function performSearch(query) {
    hideDesktopRecentSearches();
    appState.displayLimit = 12;

    if (PERF.currentSearchAbort) PERF.currentSearchAbort.abort();
    const abortController = new AbortController();
    PERF.currentSearchAbort = abortController;

    // MUDANÇA: "stale-while-revalidate" pra busca ficar o mais instantânea
    // possível. Antes, só mostrava o cache se ele tivesse menos de 5 minutos;
    // passou disso, caía direto pro skeleton (tela em branco) e esperava a
    // rede. Agora: mesmo um cache "vencido" (mais velho que 5min) é exibido
    // na hora — é sempre melhor que tela em branco — enquanto a versão
    // atualizada é buscada por trás e substitui sozinha quando chega. Só não
    // dispara uma busca nova se o cache for BEM recente (<15s), pra não gastar
    // rede repetindo a mesma busca que acabou de rodar.
    const rawEntry = PERF.searchCache.get(normalizeQueryKey(query));
    const cached = getCachedSearchResult(query) || (rawEntry ? rawEntry.videos : null);
    if (cached) {
        appState.lastSearchResult = cached;
        renderSearchResults(cached, query, true, true);
        warmTrackImages(cached);
        if (rawEntry && (Date.now() - rawEntry.ts < 15000)) return;
    } else {
        renderSkeleton();
    }

    const searchTimeoutId = setTimeout(() => {
        if (PERF.currentSearchAbort === abortController) abortController.abort();
    }, 10000);

    try {
        const response = await fetch('/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
            signal: abortController.signal
        });

        if (!response.ok) throw new Error("API Fails");
        const data = await response.json();
        const videos = data.videos || [];
        appState.lastSearchResult = videos;

        if (videos.length === 0) {
            renderSearchEmptyState(query, false);
        } else {
            cacheSearchResult(query, videos);
            renderSearchResults(videos, query, true);
            warmTrackImages(videos);
        }
    } catch (e) {
        if (e.name === 'AbortError' && PERF.currentSearchAbort !== abortController) return;
        // Antes aqui caía num fallback de músicas inventadas ("Hit Oficial Teste
        // Longo..."). Agora mostramos que a busca falhou de verdade, com um jeito
        // fácil de tentar de novo — sem sobrecarregar o servidor sem necessidade.
        if (PERF.currentSearchAbort === abortController) renderSearchEmptyState(query, true);
    } finally {
        clearTimeout(searchTimeoutId);
    }
}

// =============================================================================
// MUDANÇA: página de canal/artista agora tem paginação "Mostrar Mais" (igual
// playlists e busca) em vez de carregar tudo de uma vez, e também não mostra
// mais vídeos inventados quando a busca do canal falha — mostra um aviso real.
// =============================================================================
let _channelFullQueue = [];
let _channelArtistName = '';
let _channelDisplayLimit = 12;

async function openArtistPlaylist(artistName) {
    renderSkeleton();
    try {
        const response = await fetch('/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: artistName })
        });
        if (!response.ok) throw new Error("API Fails");
        const data = await response.json();
        if (!data.videos || data.videos.length === 0) {
            renderSearchEmptyState(artistName, false);
            return;
        }
        renderArtistView(data.videos, artistName);
    } catch (e) {
        renderSearchEmptyState(artistName, true);
    }
}

function renderArtistView(videos, artistName) {
    if (!videos || videos.length === 0) return showToast("Nenhum vídeo encontrado.");
    setHeaderColor('#509bf5');

    _channelFullQueue = videos.map(v => ({
        id: v.url, title: v.title, artist: v.artist || artistName,
        cover: v.thumbnail || DEFAULT_COVER, url: v.url, duration: v.duration
    }));
    _channelArtistName = artistName;
    _channelDisplayLimit = 12;

    // MUDANÇA: antes isso jogava direto em appState.queue/queueContext só de
    // ABRIR a página do artista (mesmo sem clicar em nada) — se você tivesse
    // uma música de uma playlist tocando, o "Agora tocando"/Visualização de
    // Reprodução passava a mostrar (ou tentar mostrar) a música errada, só
    // por ter visitado essa tela. Agora só guarda os dados prontos em
    // _channelFullQueue; a fila de verdade só muda quando clica pra tocar
    // (playTrackFromContext, mais abaixo neste arquivo, sabe montar a fila
    // certa na hora com base no _channelFullQueue).
    const contextKey = 'artist_' + artistName;
    const safeContextKey = contextKey.replace(/'/g, "\\'");

    const isFollowed = appState.followedArtists.includes(artistName);

    dom.viewContainer.innerHTML = `
        <div class="w-full max-w-[1500px] mx-auto flex flex-col">
            <button class="md:hidden w-8 h-8 rounded-full bg-black/50 flex items-center justify-center text-white mb-2 self-start focus:outline-none" onclick="goBack()"><i class="ph-bold ph-caret-left text-lg"></i></button>

            <div class="mt-4 mb-6 flex flex-col md:flex-row items-center md:items-end gap-6 fade-in w-full">
                <div class="w-48 h-48 md:w-[232px] md:h-[232px] rounded-full overflow-hidden shadow-[0_4px_60px_rgba(0,0,0,0.5)] bg-[#282828] shrink-0">
                    <img src="${_channelFullQueue[0].cover}" loading="eager" decoding="async" class="w-full h-full object-cover" onerror="this.src='${DEFAULT_COVER}'">
                </div>
                <div class="flex-1 overflow-hidden text-center md:text-left min-w-0 w-full mt-2 md:mt-0">
                    <div class="flex items-center justify-center md:justify-start gap-2 mb-2">
                        <i class="ph-fill ph-check-circle text-blue-400 text-xl shadow-sm shrink-0"></i>
                        <span class="text-sm text-white font-medium shrink-0">Artista Verificado</span>
                    </div>
                    <h1 class="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black text-white mb-4 md:mb-2 tracking-tighter text-truncate-safe py-2 w-full">${artistName}</h1>
                    <span class="text-white/80 text-sm font-medium">${_channelFullQueue.length} vídeos/músicas nesta lista</span>
                </div>
            </div>

            <div class="py-4 flex items-center gap-6 mb-4 fade-in">
                <button class="w-14 h-14 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-[1.04] transition shadow-lg focus:outline-none shrink-0" onclick="playTrackFromContext('${safeContextKey}', 0)">
                    <i class="ph-fill ph-play text-[24px] translate-x-[2px]"></i>
                </button>
                <button class="text-spotify-text hover:text-spotify-green transition focus:outline-none flex items-center justify-center shrink-0 tooltip" title="Ordem Aleatória" onclick="toggleShuffle(); this.querySelector('i').classList.toggle('text-spotify-green'); this.querySelector('i').classList.toggle('text-spotify-text');">
                    <i class="ph-bold ph-shuffle text-[32px] ${playerState.isShuffle ? 'text-spotify-green' : 'text-spotify-text'}"></i>
                </button>
                <button id="followArtistBtn" class="border border-white/50 text-white font-bold text-[13px] tracking-widest uppercase px-4 py-1.5 rounded-full hover:border-white hover:scale-105 transition focus:outline-none shrink-0 ml-2" onclick="toggleFollowArtist('${artistName.replace(/'/g, "\\'")}')">${isFollowed ? 'Seguindo' : 'Seguir'}</button>
            </div>
            <h2 class="text-white text-2xl font-bold mb-4 fade-in tracking-tight">Populares</h2>
            <div class="flex flex-col pb-20 fade-in w-full" id="channelTracksContainer"></div>
        </div>
    `;
    renderChannelTracksPage();
}

function renderChannelTracksPage() {
    const container = document.getElementById('channelTracksContainer');
    if (!container) return;
    const limit = Math.min(_channelFullQueue.length, _channelDisplayLimit);
    const contextKey = 'artist_' + _channelArtistName;
    let html = '';
    for (let i = 0; i < limit; i++) html += generateTrackRow(_channelFullQueue[i], i, contextKey);
    if (_channelFullQueue.length > limit) {
        html += `<button class="text-spotify-text hover:text-white font-bold text-sm mt-4 px-4 py-2 rounded-full border border-white/20 hover:border-white transition mx-auto block" onclick="loadMoreChannelTracks()">Mostrar Mais</button>`;
    }
    container.innerHTML = html;
    warmTrackImages(_channelFullQueue.slice(0, limit));
    updateActiveTrackUI();
}

function loadMoreChannelTracks() {
    _channelDisplayLimit += 12;
    renderChannelTracksPage();
}

// =============================================================================
// (CSV e importação de playlist inteira por link já funcionavam no index.html —
// nenhuma mudança necessária aqui.)
// =============================================================================

// =============================================================================
// MUDANÇA: Home totalmente redesenhada — bem mais "recheada" e com cara de
// streaming de verdade (era mais crua/fria antes): blobs animados atrás da
// saudação, mensagem dinâmica baseada no que o usuário já tem, um carrossel
// de "Novidades & dicas" do próprio app, seção de artistas seguidos, "Em
// Alta" virou carrossel de capas (em vez de lista simples) e ganhou uma
// SEGUNDA leva de recomendações baseada no 2º artista mais ouvido (antes só
// tinha uma). Sobrescreve renderHome() — mesmo padrão de sempre: função com
// o mesmo nome, carregada por último, ganha prioridade.
//
// De brinde, aproveitando que essa função tava sendo reescrita mesmo:
// corrigido um bug real que já existia no index.html — os cards de "Seus
// Mixes" chamavam uma função "MapsTo(...)" que não existe em lugar nenhum
// (o próprio comentário original já dizia "// Fix the clickAction"), então
// clicar neles não fazia nada. Agora usa navigateTo(), que é a função certa.
//
// Não mexe em busca nem no pipeline de áudio — só usa dados que já existem
// em appState / topTrendingData / recommendedData, e reorganiza a exibição.
//
// PS conferido nesta sessão (sem precisar mudar nada):
//  - Músicas importadas (link ou CSV) já ficam salvas de verdade: o fluxo de
//    importação exige login (checkAuth) e sempre chama saveData() no final,
//    que persiste tudo na nuvem (Firestore) pra quem tá logado.
//  - O botão "Mostrar Mais" já funciona tanto na busca (nativo do
//    index.html, via loadMoreContent) quanto nos artistas (pela paginação
//    que este próprio arquivo já implementava lá embaixo, no bloco de
//    canal/artista — renderChannelTracksPage/loadMoreChannelTracks).
// =============================================================================

// --- "Novidades & dicas" do app: mensagens curtas que giram sozinhas, com
// bolinhas pra navegar manualmente. Some por ~20h depois de fechada (guardado
// no localStorage), pra não ficar enchendo o saco toda vez que abre a Home. ---
const HOME_TIPS = [
    { icon: 'ph-sparkle',            color: 'from-[#1ed760] to-[#0a8a3e]', title: 'Bora descobrir algo novo?',   text: 'Busque um artista ou cole um link do YouTube pra importar direto na sua biblioteca.' },
    { icon: 'ph-cast',                color: 'from-[#509bf5] to-[#2151a8]', title: 'Toque em qualquer lugar',     text: 'Use o botão Conectar pra jogar a música na TV, Chromecast ou AirPlay.' },
    { icon: 'ph-list-dashes',         color: 'from-[#af2896] to-[#5c1152]', title: 'Reordene sua fila',           text: 'Arraste as músicas na fila de reprodução pra tocar na ordem que você quiser.' },
    { icon: 'ph-keyboard',            color: 'from-[#e8a33d] to-[#a5641a]', title: 'Atalhos de teclado',          text: 'Espaço pra play/pause, setas pra navegar — dá uma olhada nos atalhos do Exlify.' },
    { icon: 'ph-picture-in-picture',  color: 'from-[#1ed760] to-[#127a3e]', title: 'Mini player flutuante',       text: 'No desktop, arraste as bordas do mini player pra deixar do tamanho que você quiser.' }
];
let _homeTipIndex = 0;
let _homeTipTimer = null;

function shouldShowHomeTips() {
    try {
        const dismissedAt = localStorage.getItem('exlify_tips_dismissed_at');
        if (!dismissedAt) return true;
        return (Date.now() - Number(dismissedAt)) > (20 * 60 * 60 * 1000);
    } catch (e) { return true; }
}

function dismissHomeTips() {
    try { localStorage.setItem('exlify_tips_dismissed_at', String(Date.now())); } catch (e) {}
    clearInterval(_homeTipTimer);
    const el = document.getElementById('homeTipsCard');
    if (el) {
        el.style.transition = 'opacity .2s ease, transform .2s ease';
        el.style.opacity = '0';
        el.style.transform = 'translateY(-6px) scale(0.98)';
        setTimeout(() => el.remove(), 200);
    }
}

function renderHomeTipContent() {
    const tip = HOME_TIPS[_homeTipIndex];
    const dots = HOME_TIPS.map((_, i) => `<span class="home-tip-dot ${i === _homeTipIndex ? 'active' : ''}" onclick="goToHomeTip(${i})"></span>`).join('');
    return `
        <div class="w-12 h-12 rounded-xl bg-gradient-to-br ${tip.color} flex items-center justify-center shrink-0 shadow-lg home-tip-icon">
            <i class="ph-fill ${tip.icon} text-white text-2xl"></i>
        </div>
        <div class="flex-1 min-w-0">
            <h4 class="text-white font-bold text-[15px] mb-0.5 truncate">${tip.title}</h4>
            <p class="text-spotify-text text-[13px] leading-snug line-clamp-2">${tip.text}</p>
        </div>
        <div class="hidden sm:flex items-center gap-1.5 shrink-0 mx-2">${dots}</div>
    `;
}

function goToHomeTip(i) {
    _homeTipIndex = i;
    const body = document.getElementById('homeTipsBody');
    if (body) {
        body.classList.remove('home-tip-fade');
        void body.offsetWidth; // reinicia a animação
        body.innerHTML = renderHomeTipContent();
        body.classList.add('home-tip-fade');
    }
    restartHomeTipTimer();
}

function advanceHomeTip() { goToHomeTip((_homeTipIndex + 1) % HOME_TIPS.length); }

function restartHomeTipTimer() {
    clearInterval(_homeTipTimer);
    _homeTipTimer = setInterval(() => {
        if (!document.getElementById('homeTipsCard')) { clearInterval(_homeTipTimer); return; }
        advanceHomeTip();
    }, 7000);
}

function renderHomeTipsWidget() {
    if (!shouldShowHomeTips()) return '';
    _homeTipIndex = Math.floor(Math.random() * HOME_TIPS.length);
    return `
        <div id="homeTipsCard" class="home-tips-card fade-in relative w-full rounded-xl p-4 mb-6 flex items-center gap-4 overflow-hidden">
            <div id="homeTipsBody" class="flex items-center gap-4 flex-1 min-w-0 home-tip-fade">${renderHomeTipContent()}</div>
            <button class="text-spotify-text hover:text-white transition focus:outline-none shrink-0 p-1" onclick="dismissHomeTips()" title="Fechar">
                <i class="ph-bold ph-x text-lg"></i>
            </button>
        </div>
    `;
}

// --- Mensagem dinâmica embaixo da saudação, baseada no que o usuário já tem ---
function getHomeSubMessage() {
    if (!currentUser) return 'Explore à vontade — crie uma conta pra salvar suas músicas e playlists.';
    const likedCount = (appState.likedSongs || []).length;
    const playlistCount = (appState.playlists || []).filter(p => p.type !== 'system').length;
    const followedCount = (appState.followedArtists || []).length;
    if (likedCount === 0 && playlistCount === 0 && followedCount === 0) return 'Que tal começar buscando sua música favorita?';
    const parts = [];
    if (likedCount > 0) parts.push(`${likedCount} música${likedCount > 1 ? 's' : ''} curtida${likedCount > 1 ? 's' : ''}`);
    if (playlistCount > 0) parts.push(`${playlistCount} playlist${playlistCount > 1 ? 's' : ''}`);
    if (followedCount > 0) parts.push(`${followedCount} artista${followedCount > 1 ? 's' : ''} seguido${followedCount > 1 ? 's' : ''}`);
    return 'Você já tem ' + parts.join(', ') + ' por aqui. 🎶';
}

// --- Card de faixa reutilizável (Tocadas recentemente / Em Alta / Recomendadas) ---
function homeTrackCard(t, i, context, opts) {
    opts = opts || {};
    const widthClass = opts.widthClass || 'w-[140px] sm:w-auto';
    const isPlaying = appState.queueContext === context && appState.currentTrackIndex === i;
    const clickAttr = opts.onclick || `playTrackFromContext('${context}', ${i})`;
    const ringClass = isPlaying ? 'ring-2 ring-[#1ed760]' : '';
    const badgeHtml = opts.rank ? `<div class="absolute top-2 left-2 bg-black/70 backdrop-blur-sm text-[#1ed760] font-black text-[13px] w-6 h-6 rounded-full flex items-center justify-center z-10">${i + 1}</div>` : '';
    return `
        <div class="bg-[#181818] hover:bg-[#282828] p-3 rounded-lg transition cursor-pointer group shrink-0 ${widthClass} card-hover-lift fade-in-stagger" style="animation-delay:${Math.min(i, 12) * 40}ms" onclick="${clickAttr}">
            <div class="relative w-full aspect-square mb-3 rounded-md overflow-hidden ${ringClass}">
                <img src="${t.cover || DEFAULT_COVER}" loading="lazy" decoding="async" class="w-full h-full object-cover" onerror="this.src='${DEFAULT_COVER}'">
                ${badgeHtml}
                <button class="absolute bottom-2 right-2 w-10 h-10 rounded-full bg-[#1ed760] text-black flex items-center justify-center ${isPlaying ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition hover:scale-105 shadow-xl focus:outline-none z-10">
                    <i class="ph-fill ${isPlaying ? 'ph-speaker-simple-high' : 'ph-play'} text-lg translate-x-[1px]"></i>
                </button>
            </div>
            <h3 class="text-white font-bold mb-0.5 truncate text-[14px]">${t.title}</h3>
            <p class="text-[13px] text-spotify-text truncate">${t.artist}</p>
        </div>`;
}

// --- "Seus Mixes" (playlists do usuário) — agora com o clique corrigido ---
function renderHomeTopCards() {
    let topItems = appState.playlists.slice(0, 6);
    const placeholders = [
        { name: 'Descubra Novidades', mockQuery: 'lançamentos 2026', color: '1ed760' },
        { name: 'Seu Mix Diário',     mockQuery: 'Tudo',              color: '509bf5' },
        { name: 'Rádio Exlify',       mockQuery: 'Top Brasil',        color: 'af2896' }
    ];
    let pIdx = 0;
    while (topItems.length < 6 && pIdx < placeholders.length) {
        const p = placeholders[pIdx++];
        topItems.push({ name: p.name, cover: `https://placehold.co/120x120/${p.color}/000?text=Exlify`, type: 'mock', mockQuery: p.mockQuery });
    }
    return topItems.map((item, i) => {
        const isReal = item.id !== undefined;
        const safeQuery = (item.mockQuery || 'Tudo').replace(/'/g, "\\'");
        const clickAction = isReal ? `navigateTo('playlist', '${item.id}')` : `searchStyle('${safeQuery}')`;
        return `
            <div class="home-mix-card bg-white/10 hover:bg-white/20 transition flex items-center rounded overflow-hidden cursor-pointer group h-[60px] sm:h-20 fade-in-stagger" style="animation-delay:${i * 35}ms" onclick="${clickAction}">
                <img src="${item.cover || DEFAULT_COVER}" loading="lazy" decoding="async" class="relative z-10 w-[60px] sm:w-20 h-full object-cover shadow-[0_0_10px_rgba(0,0,0,0.5)] shrink-0" onerror="this.src='${DEFAULT_COVER}'">
                <div class="flex-1 px-4 font-bold text-white text-[14px] sm:text-[15px] line-clamp-2 relative z-10">${item.name}</div>
                ${isReal ? `<button class="w-12 h-12 rounded-full bg-[#1ed760] text-black flex items-center justify-center mr-4 opacity-0 group-hover:opacity-100 transition hover:scale-105 shadow-xl focus:outline-none shrink-0 relative z-10" onclick="event.stopPropagation(); playContext('${item.id}')"><i class="ph-fill ph-play text-[22px] translate-x-[1px]"></i></button>` : ''}
            </div>`;
    }).join('');
}

// --- Tocadas recentemente ---
function renderHomeRecentlyPlayed() {
    if (!appState.recentlyPlayed || appState.recentlyPlayed.length === 0) return '';
    const cards = appState.recentlyPlayed.slice(0, 10).map((t, i) => homeTrackCard(t, i, 'recentlyPlayed', { onclick: `playFromRecentlyPlayed(${i})` })).join('');
    return `
        <div class="flex items-baseline justify-between mb-4 mt-2">
            <h2 class="text-white text-[22px] font-bold tracking-tight">Tocadas recentemente</h2>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6 pb-4 mb-10">
            ${cards}
        </div>`;
}

// --- Artistas que você segue (agora também aparece na Home, não só na biblioteca) ---
function renderHomeArtistsRow() {
    if (!appState.followedArtists || appState.followedArtists.length === 0) return '';
    const cards = appState.followedArtists.slice(0, 12).map((art, i) => {
        const safe = art.replace(/'/g, "\\'");
        return `
            <div class="flex flex-col items-center gap-2 shrink-0 w-[110px] cursor-pointer group card-hover-lift fade-in-stagger" style="animation-delay:${i * 40}ms" onclick="openArtistPlaylist('${safe}')">
                <div class="w-24 h-24 rounded-full overflow-hidden shadow-lg ring-2 ring-transparent group-hover:ring-[#1ed760] transition">
                    <img src="https://placehold.co/200x200/282828/fff?text=${encodeURIComponent(art.substring(0, 2))}" class="w-full h-full object-cover">
                </div>
                <p class="text-white text-[13px] font-medium text-center truncate w-full">${art}</p>
                <p class="text-spotify-text text-[11px]">Artista</p>
            </div>`;
    }).join('');
    return `
        <div class="flex items-baseline justify-between mb-4 mt-2">
            <h2 class="text-white text-[22px] font-bold tracking-tight">Seus artistas</h2>
        </div>
        <div class="flex gap-4 sm:gap-5 overflow-x-auto pb-4 custom-scrollbar hide-scrollbar-mobile mb-2">${cards}</div>`;
}

// --- Em Alta agora: virou carrossel de capas com selo de posição (era lista simples) ---
function renderHomeTrending() {
    if (!isTrendingLoaded) {
        return `
            <div class="flex gap-4 sm:gap-5 overflow-x-auto pb-2 custom-scrollbar hide-scrollbar-mobile">
                ${Array(6).fill('<div class="w-[150px] sm:w-[170px] shrink-0"><div class="w-full aspect-square rounded-md skeleton-shimmer mb-3"></div><div class="h-3 w-3/4 rounded skeleton-shimmer mb-2"></div><div class="h-3 w-1/2 rounded skeleton-shimmer"></div></div>').join('')}
            </div>`;
    }
    // MUDANÇA: antes isso substituía a fila/contexto GLOBAL só de renderizar a
    // Home (mesmo sem clicar em nada) — se uma música de uma playlist estivesse
    // tocando, a Visualização de Reprodução podia mostrar informação errada só
    // por você ter passado pela Home. Agora playTrackFromContext (mais abaixo)
    // monta a fila de "trending" sozinho, na hora do clique.
    const cards = topTrendingData.map((t, i) => homeTrackCard(t, i, 'trending', { rank: true, widthClass: 'w-[150px] sm:w-[170px] shrink-0' })).join('');
    return `<div class="flex gap-4 sm:gap-5 overflow-x-auto pb-4 custom-scrollbar hide-scrollbar-mobile">${cards}</div>`;
}

// --- Recomendações: agora com uma 2ª fileira baseada no 2º artista mais ouvido ---
function renderHomeRecommendedRow(data, basis, loaded, context) {
    if (!loaded) {
        if (context !== 'recommended' || !appState.recentlyPlayed || appState.recentlyPlayed.length === 0) return '';
        return `
            <div class="flex items-baseline justify-between mb-4 mt-2">
                <h2 class="text-white text-[22px] font-bold tracking-tight">Recomendado para você</h2>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6 pb-4 mb-10">
                ${Array(6).fill('<div><div class="w-full aspect-square rounded-md mb-3 skeleton-shimmer"></div><div class="h-3 rounded w-3/4 mb-1 skeleton-shimmer"></div><div class="h-3 rounded w-1/2 skeleton-shimmer"></div></div>').join('')}
            </div>`;
    }
    if (!data || data.length === 0) return '';
    const queueVar = context === 'recommended' ? 'recommendedData' : 'recommendedData2';
    const cards = data.map((t, i) => homeTrackCard(t, i, context, { onclick: `appState.queueContext='${context}'; appState.queue=[...${queueVar}]; playTrackFromContext('${context}', ${i})` })).join('');
    return `
        <div class="flex items-baseline justify-between mb-4 mt-2">
            <h2 class="text-white text-[22px] font-bold tracking-tight">Baseado em ${basis}</h2>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6 pb-4 mb-10">
            ${cards}
        </div>`;
}

// --- Segunda leva de recomendações (2º artista mais ouvido) ---
let recommendedData2 = [];
let recommendedBasis2 = '';
let isRecommended2Loaded = false;

async function fetchArtistRecommendations(artistName, alreadyHeardSet, idPrefix) {
    try {
        const response = await fetch('/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: artistName })
        });
        if (!response.ok) return [];
        const data = await response.json();
        if (!data.videos || data.videos.length === 0) return [];
        return data.videos
            .filter(v => !alreadyHeardSet.has(v.url))
            .slice(0, 10)
            .map((v, i) => ({
                id: v.url || `${idPrefix}_${i}`, title: v.title, artist: v.artist || (v.author && v.author.name) || artistName,
                cover: v.thumbnail || DEFAULT_COVER, url: v.url, duration: v.duration || '0:00'
            }));
    } catch (e) { console.error("Erro ao carregar recomendações de " + artistName, e); return []; }
}

// MUDANÇA: agora busca as recomendações do 1º E do 2º artista mais ouvido em
// paralelo (Promise.all), em vez de só o 1º — Home fica com mais conteúdo
// pra explorar, igual o Spotify faz com vários "Baseado em..." diferentes.
async function loadRecommendations() {
    if (!appState.recentlyPlayed || appState.recentlyPlayed.length === 0) {
        isRecommendedLoaded = true; isRecommended2Loaded = true; return;
    }
    const counts = {};
    appState.recentlyPlayed.forEach(t => {
        const artist = (t.artist || '').trim();
        if (!artist) return;
        counts[artist] = (counts[artist] || 0) + 1;
    });
    const ranked = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const topArtist = ranked[0];
    const secondArtist = ranked[1];

    if (!topArtist) { isRecommendedLoaded = true; isRecommended2Loaded = true; return; }

    const alreadyHeard = new Set(appState.recentlyPlayed.map(t => t.id));
    recommendedBasis = topArtist;
    recommendedBasis2 = secondArtist || '';

    const [list1, list2] = await Promise.all([
        fetchArtistRecommendations(topArtist, alreadyHeard, 'rec'),
        secondArtist ? fetchArtistRecommendations(secondArtist, alreadyHeard, 'rec2') : Promise.resolve([])
    ]);

    recommendedData = list1;
    recommendedData2 = list2;
    isRecommendedLoaded = true;
    isRecommended2Loaded = true;
    if (recommendedData.length) warmTrackImages(recommendedData);
    if (recommendedData2.length) warmTrackImages(recommendedData2);

    if (currentView === 'home') renderHome();
}

// --- "Feito para você": grade de descoberta com selo colorido (era mais crua antes) ---
const HOME_DISCOVERY_ITEMS = [
    { title: 'Descobertas',        desc: 'Novas músicas selecionadas.',   img: 'https://musicopolis.com.br/wp-content/uploads/2025/05/Tubaroes-de-Diego-e-Victor-Hugo-e-a-musica-sertaneja-mais-tocada-de-abril.webp', tag: 'Selecionado', query: 'Descobertas' },
    { title: 'Radar de Novidades', desc: 'Lançamentos da semana.',        img: 'https://image-cdn-fa.spotifycdn.com/image/ab67706c0000da8481e3d7525172caf199acce11', tag: 'Novo', query: 'lançamentos 2026' },
    { title: 'Top Brasil',         desc: 'As mais tocadas no momento.',   img: 'https://i.scdn.co/image/ab67616d0000b2739f2f923c01834c4b1c1084ec', tag: 'Em alta', query: 'Top Brasil' },
    { title: 'Lofi Beats',         desc: 'Batidas relaxantes.',           img: 'https://i.ytimg.com/vi/5qap5aO4i9A/maxresdefault.jpg', tag: 'Foco', query: 'Lofi Beats' }
];
function renderHomeDiscoveryGrid() {
    return HOME_DISCOVERY_ITEMS.map((item, i) => {
        const safeQuery = item.query.replace(/'/g, "\\'");
        return `
            <div class="home-discovery-card bg-[#181818] hover:bg-[#282828] p-4 rounded-lg transition cursor-pointer group shrink-0 card-hover-lift fade-in-stagger" style="animation-delay:${i * 50}ms" onclick="searchStyle('${safeQuery}')">
                <div class="relative w-full aspect-square mb-4 overflow-hidden rounded-md">
                    <img src="${item.img}" loading="lazy" decoding="async" class="w-full h-full object-cover">
                    <span class="absolute top-2 left-2 bg-black/70 backdrop-blur-sm text-white text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full">${item.tag}</span>
                    <button class="absolute bottom-2 right-2 w-12 h-12 rounded-full bg-[#1ed760] text-black flex items-center justify-center opacity-0 group-hover:opacity-100 transition hover:scale-105 hover:-translate-y-1 shadow-xl translate-y-1 focus:outline-none z-10">
                        <i class="ph-fill ph-play text-[22px] translate-x-[1px]"></i>
                    </button>
                </div>
                <h3 class="text-white font-bold mb-1 truncate text-[15px] pb-0.5">${item.title}</h3>
                <p class="text-[14px] text-spotify-text line-clamp-2 leading-tight">${item.desc}</p>
            </div>`;
    }).join('');
}

// --- A Home em si ---
function renderHome() {
    setHeaderColor('#333333');
    clearInterval(_homeTipTimer);

    const reduceMotion = !!(appState.settings && appState.settings.reduceMotion);
    const hasAnyPersonalization = (appState.recentlyPlayed && appState.recentlyPlayed.length > 0)
        || (appState.followedArtists && appState.followedArtists.length > 0)
        || (appState.playlists && appState.playlists.some(p => p.type !== 'system'))
        || (appState.likedSongs && appState.likedSongs.length > 0);

    const tipsWidgetHtml = renderHomeTipsWidget();
    const topMixHtml = renderHomeTopCards();
    const recentlyPlayedHtml = renderHomeRecentlyPlayed();
    const artistsRowHtml = renderHomeArtistsRow();
    const trendingHtml = renderHomeTrending();
    const recommendedHtml = renderHomeRecommendedRow(recommendedData, recommendedBasis, isRecommendedLoaded, 'recommended');
    const recommended2Html = recommendedBasis2 ? renderHomeRecommendedRow(recommendedData2, recommendedBasis2, isRecommended2Loaded, 'recommended2') : '';
    const discoveryHtml = renderHomeDiscoveryGrid();
    const emptyStateHtml = hasAnyPersonalization ? '' : `
        <div class="search-empty-state fade-in">
            <i class="ph-bold ph-vinyl-record"></i>
            <h3>Sua Home ainda tá esperando você</h3>
            <p>Busque uma música ou artista, curta o que gostar, e a gente vai enchendo essa página de recomendações do seu jeito.</p>
            <button onclick="navigateTo('search')">Buscar agora</button>
        </div>`;

    dom.viewContainer.innerHTML = `
        <div class="w-full max-w-[1500px] mx-auto fade-in flex flex-col relative pt-4 md:pt-0">

            <div id="loginBanner" class="${currentUser ? 'hidden' : 'flex'} w-full bg-gradient-to-r from-[#af2896] to-[#509bf5] rounded-lg p-4 mb-6 flex-col sm:flex-row items-center justify-between gap-4 shadow-lg cursor-pointer hover:scale-[1.01] transition" onclick="openAuthModal()">
                <div>
                    <p class="text-white text-xs uppercase tracking-widest font-bold mb-1">Preview</p>
                    <h3 class="text-white font-bold text-base sm:text-lg">🎶 Quer salvar suas playlists e curtir em qualquer lugar?</h3>
                    <p class="text-white/90 text-sm">Crie sua conta ou faça login para ter a experiência completa.</p>
                </div>
                <button class="bg-white text-black font-bold px-6 py-2.5 rounded-full shrink-0 hover:scale-105 transition">Entrar grátis</button>
            </div>

            <div id="installAppBanner" class="${deferredPrompt ? 'flex' : 'hidden'} w-full bg-[#242424] hover:bg-[#2a2a2a] rounded-lg p-4 mb-6 items-center justify-between gap-4 shadow-lg cursor-pointer transition">
                <div class="flex items-center gap-4">
                    <i class="ph-fill ph-device-mobile text-spotify-green text-[40px]"></i>
                    <div>
                        <h3 class="text-white font-bold text-[16px]">Instale o Exlify App</h3>
                        <p class="text-spotify-text text-sm">Adicione à tela inicial para acesso rápido e nativo.</p>
                    </div>
                </div>
                <button class="bg-transparent border border-white/50 text-white font-bold px-5 py-2 rounded-full shrink-0 focus:outline-none hover:scale-105 hover:border-white transition" onclick="installPWA()">Instalar</button>
            </div>

            <div class="home-hero-wrap px-1 py-2 mb-2">
                ${reduceMotion ? '' : '<div class="home-hero-blob b1"></div><div class="home-hero-blob b2"></div>'}
                <div class="relative z-10">
                    <h2 class="text-white text-2xl sm:text-3xl font-bold tracking-tight">${getGreeting()}${currentUser ? ', ' + (currentUser.displayName || '').split(' ')[0] : ''}</h2>
                    <p class="text-spotify-text text-[14px] sm:text-[15px] mt-1">${getHomeSubMessage()}</p>
                </div>
            </div>

            ${tipsWidgetHtml}

            <div class="flex items-center gap-2 mb-6 overflow-x-auto custom-scrollbar pb-2 hide-scrollbar-mobile w-full mt-2">
                <button class="home-chip" onclick="searchStyle('Podcasts')"><i class="ph-bold ph-microphone-stage text-lg"></i> Podcasts</button>
                <button class="home-chip" onclick="searchStyle('Sertanejo')"><i class="ph-bold ph-guitar text-lg"></i> Sertanejo</button>
                <button class="home-chip" onclick="searchStyle('Pop')"><i class="ph-bold ph-star text-lg"></i> Pop</button>
                <button class="home-chip" onclick="searchStyle('Relax')"><i class="ph-bold ph-coffee text-lg"></i> Relax</button>
                <button class="home-chip" onclick="searchStyle('Treino')"><i class="ph-bold ph-barbell text-lg"></i> Treino</button>
                <button class="home-chip" onclick="searchStyle('Funk')"><i class="ph-bold ph-vinyl-record text-lg"></i> Funk</button>
            </div>

            ${emptyStateHtml}

            <div class="grid grid-cols-2 xl:grid-cols-3 gap-2 sm:gap-3 mb-10">
                ${topMixHtml}
            </div>

            ${recentlyPlayedHtml}
            ${artistsRowHtml}

            <div class="flex items-baseline justify-between mb-4">
                <h2 class="text-white text-[22px] font-bold tracking-tight flex items-center gap-2">🔥 Em alta agora <span class="text-[11px] font-medium text-spotify-text bg-white/5 px-2 py-0.5 rounded-full normal-case">via YouTube</span></h2>
            </div>
            <div class="mb-10">
                ${trendingHtml}
            </div>

            ${recommendedHtml}
            ${recommended2Html}

            <div class="flex items-baseline justify-between mb-4 mt-2">
                <h2 class="text-white text-[22px] font-bold tracking-tight">Feito para você</h2>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6 pb-10">
                ${discoveryHtml}
            </div>

        </div>
    `;

    if (document.getElementById('homeTipsCard')) restartHomeTipTimer();
    setTimeout(updateActiveTrackUI, 50);
}

// =============================================================================
// MUDANÇA: fila de reprodução calculada "sob demanda" no clique, não mais no
// render. Esse era o motivo real do bug "a Visualização de Reprodução perde
// a música ao sair da playlist": Busca, Em Alta, Artista e as fileiras da
// Home jogavam a lista inteira em appState.queue/queueContext SÓ DE ABRIR A
// TELA (sem clicar em nada) — se uma música de OUTRA playlist estivesse
// tocando, o ponteiro global virava lixo (índice antigo apontando pra uma
// fila nova errada) e a Visualização de Reprodução/rodapé passavam a mostrar
// informação errada ou em branco. Agora playTrackFromContext monta a fila
// certa NA HORA do clique — a fila de "verdade" (o que está tocando) só muda
// quando você realmente manda tocar algo, nunca só de navegar/olhar.
// =============================================================================
function deriveQueueForContext(context) {
    if (context === 'search') return appState.lastSearchResult ? [...appState.lastSearchResult] : null;
    if (context === 'trending') return (typeof topTrendingData !== 'undefined' && topTrendingData.length) ? [...topTrendingData] : null;
    if (context === 'recommended') return (typeof recommendedData !== 'undefined' && recommendedData.length) ? [...recommendedData] : null;
    if (context === 'recommended2') return (typeof recommendedData2 !== 'undefined' && recommendedData2.length) ? [...recommendedData2] : null;
    if (context === 'recentlyPlayed') return appState.recentlyPlayed ? [...appState.recentlyPlayed] : null;
    if (context.startsWith('artist_')) return (typeof _channelFullQueue !== 'undefined' && _channelFullQueue.length) ? [..._channelFullQueue] : null;
    if (context.startsWith('foreign_') && typeof _foreignPreviewId !== 'undefined' && context === 'foreign_' + _foreignPreviewId) {
        return _foreignPreviewTracks.length ? [..._foreignPreviewTracks] : null;
    }
    const pl = appState.playlists.find(p => p.id === context);
    if (pl) return [...pl.tracks];
    return null;
}
const _EPHEMERAL_QUEUE_CONTEXTS = new Set(['search', 'trending', 'recommended', 'recommended2', 'recentlyPlayed']);
function _isEphemeralContext(context) {
    return _EPHEMERAL_QUEUE_CONTEXTS.has(context) || context.startsWith('artist_') || context.startsWith('foreign_');
}

function playTrackFromContext(context, index) {
    // Contextos "efêmeros" (busca, em alta, artista, recomendadas, previews)
    // recalculam a fila TODA vez que você clica — é barato (só copia um
    // array) e garante que nunca toca algo desatualizado. Playlists de
    // verdade continuam só recarregando ao TROCAR de playlist, como sempre
    // (preserva reordenação por Aleatório dentro da mesma playlist).
    if (appState.queueContext !== context || _isEphemeralContext(context)) {
        const derived = deriveQueueForContext(context);
        if (derived) appState.queue = derived;
        appState.queueContext = context;
    }

    appState.currentTrackIndex = index;
    const track = appState.queue[index];
    if (!track) {
        showToast("Não foi possível tocar essa música — tente de novo.");
        return;
    }
    loadAndPlayAudio(track);
    updateActiveTrackUI();
}

// Rótulo amigável do "Tocando de..." — cobre também os contextos novos da
// Home (recentlyPlayed/recommended/recommended2) que a versão original não
// conhecia (por isso caíam sempre no genérico "Exlify").
function getQueueContextLabel() {
    const ctx = appState.queueContext;
    if (ctx === 'search') return 'Busca';
    if (ctx === 'trending') return 'Em Alta';
    if (ctx === 'recentlyPlayed') return 'Tocadas Recentemente';
    if (ctx === 'recommended') return recommendedBasis ? ('Baseado em ' + recommendedBasis) : 'Recomendado para você';
    if (ctx === 'recommended2') return recommendedBasis2 ? ('Baseado em ' + recommendedBasis2) : 'Recomendado para você';
    if (ctx && ctx.startsWith('artist_')) return ctx.replace('artist_', '');
    if (ctx && ctx.startsWith('foreign_')) return _foreignPreviewName || 'Playlist';
    const p = appState.playlists.find(x => x.id === ctx);
    return p ? p.name : 'Exlify';
}

// MUDANÇA: a Visualização de Reprodução (barra direita) e o rodapé agora
// sempre refletem o que está REALMENTE tocando (appState.queue/currentTrackIndex
// globais), não importa em qual tela você está navegando — e nunca mais
// quebra silenciosamente se, por algum motivo, o índice não bater com a fila
// (mostra "Nenhuma música" em vez de travar/mostrar lixo).
function updateActiveTrackUI() {
    document.querySelectorAll('.track-row').forEach(row => {
        row.classList.remove('playing', 'bg-white/10');
        row.classList.add('hover:bg-[#2a2a2a]', 'md:hover:bg-white/10');

        const title = row.querySelector('.track-title');
        if (title) { title.classList.remove('text-[#1ed760]'); title.classList.add('text-white'); }

        const numCont = row.querySelector('.track-num-container');
        if (numCont) {
            const gif = numCont.querySelector('img');
            const span = numCont.querySelector('span');
            if (gif) gif.remove();
            if (span) span.style.display = 'inline-block';
        }
    });

    const activeRows = document.querySelectorAll(`.track-row[data-context="${appState.queueContext}"][data-index="${appState.currentTrackIndex}"]`);
    activeRows.forEach(row => {
        row.classList.add('playing', 'bg-white/10');
        row.classList.remove('hover:bg-[#2a2a2a]', 'md:hover:bg-white/10');

        const title = row.querySelector('.track-title');
        if (title) { title.classList.add('text-[#1ed760]'); title.classList.remove('text-white'); }

        const numCont = row.querySelector('.track-num-container');
        if (numCont) {
            const span = numCont.querySelector('span');
            if (span) span.style.display = 'none';
            if (!numCont.querySelector('img')) {
                numCont.insertAdjacentHTML('afterbegin', `<img src="https://open.spotifycdn.com/cdn/images/equaliser-animated-green.f5eb96f2.gif" class="w-3.5 h-3.5 track-number">`);
            }
        }
    });

    // Antes só sincronizava se a barra já estivesse aberta — daí, se ela
    // estivesse fechada enquanto você navegava, ao abrir de novo podia
    // mostrar dado velho por uma fração de segundo. Agora sempre sincroniza
    // (é barato, só troca texto/src de alguns elementos).
    updateRightSidebar();
}

function updateRightSidebar() {
    if (appState.currentTrackIndex === -1) return;
    const track = appState.queue[appState.currentTrackIndex];
    if (!track) return; // defensivo: nunca deixa a UI num estado quebrado/lixo

    const rsThumb = document.getElementById('rsThumb');
    const rsTitle = document.getElementById('rsTitle');
    const rsArtist = document.getElementById('rsArtist');
    const rsSmallThumb = document.getElementById('rsSmallThumb');
    const rsSmallTitle = document.getElementById('rsSmallTitle');
    const rsContextName = document.getElementById('rsContextName');
    const rsLikeIcon = document.getElementById('rsLikeIcon');
    if (!rsThumb) return;

    rsThumb.src = track.cover || DEFAULT_COVER;
    rsThumb.onerror = () => { rsThumb.src = DEFAULT_COVER; };
    rsTitle.innerText = track.title;
    rsArtist.innerText = track.artist;

    rsSmallThumb.src = track.cover || DEFAULT_COVER;
    rsSmallThumb.onerror = () => { rsSmallThumb.src = DEFAULT_COVER; };
    rsSmallTitle.innerText = track.title;

    rsContextName.innerText = getQueueContextLabel();

    const isLiked = appState.likedSongs.some(t => t.id === track.id);
    rsLikeIcon.className = isLiked ? "ph-fill ph-heart text-spotify-green text-[24px]" : "ph-bold ph-heart text-spotify-text text-[24px] hover:text-white";

    if (!document.getElementById('rsContentLyrics').classList.contains('hidden')) {
        fetchAndDisplayLyrics(track);
    }
}

// =============================================================================
// MUDANÇA: resultados de busca não sequestram mais a fila que está tocando
// só de aparecerem na tela — usam appState.lastSearchResult (só pra exibir).
// A fila real só é montada no clique (via playTrackFromContext, acima).
// O resto (layout, "Melhor resultado", filtros, Mostrar Mais) é idêntico.
// =============================================================================
function renderSearchResults(videos, query, updateQueue = false, fromCache = false) {
    if (!videos || videos.length === 0) {
        dom.viewContainer.innerHTML = `<h2 class="text-white text-2xl font-bold mb-4 mt-8 fade-in text-center">Nenhum resultado para "${query}"</h2>`;
        return;
    }

    let displayList;
    if (updateQueue) {
        displayList = videos.map(v => {
            let extrArtist = v.artist || (v.author && v.author.name);
            if (!extrArtist && v.title && v.title.includes('-')) extrArtist = v.title.split('-')[0].trim();
            return {
                id: v.url, title: v.title, artist: extrArtist || 'Canal Desconhecido',
                cover: v.thumbnail || DEFAULT_COVER, url: v.url, duration: v.duration
            };
        });
        appState.lastSearchResult = displayList;
    } else {
        displayList = appState.lastSearchResult || [];
    }
    if (displayList.length === 0) return;

    let tracksHtml = '';
    const limit = Math.min(displayList.length, appState.displayLimit);
    for (let index = 0; index < limit; index++) {
        tracksHtml += generateTrackRow(displayList[index], index, 'search');
    }

    const topResult = displayList[0];
    const safeArtist = topResult.artist.replace(/'/g, "\\'");

    const layoutClass = isRightSidebarOpen ? 'flex-col' : 'flex-col xl:flex-row';
    const topResultWidth = isRightSidebarOpen ? 'w-full' : 'w-full xl:w-[40%]';

    dom.viewContainer.innerHTML = `
        <div class="w-full max-w-[1500px] mx-auto">
            <div class="flex gap-2 mb-6 mt-2 overflow-x-auto pb-2 custom-scrollbar fade-in">
                <button class="filter-chip bg-white text-black px-4 py-1.5 rounded-full text-[13px] font-medium shrink-0 transition" data-filter="all" onclick="setFilter('all')">Tudo</button>
                <button class="filter-chip bg-[#242424] hover:bg-[#2a2a2a] text-white px-4 py-1.5 rounded-full text-[13px] font-medium transition shrink-0" data-filter="tracks" onclick="setFilter('tracks')">Músicas</button>
                <button class="filter-chip bg-[#242424] hover:bg-[#2a2a2a] text-white px-4 py-1.5 rounded-full text-[13px] font-medium transition shrink-0" data-filter="users" onclick="setFilter('users')">Usuários</button>
            </div>

            <div class="flex ${layoutClass} gap-6 lg:gap-8 mb-8 fade-in w-full filterable-section">

                <div class="${topResultWidth} flex-shrink-0 filterable-item" data-type="tracks">
                    <h2 class="text-white text-2xl font-bold mb-4 tracking-tight flex items-center gap-2">Melhor resultado ${fromCache ? '<span class="instant-badge"><i class="ph-fill ph-lightning"></i> instantâneo</span>' : ''}</h2>
                    <div class="bg-[#181818] hover:bg-[#282828] p-5 rounded-lg transition cursor-pointer relative group flex items-center ${isRightSidebarOpen ? '' : 'xl:flex-col xl:items-start'} gap-4 xl:gap-5 shadow-sm w-full min-h-[140px] ${isRightSidebarOpen ? '' : 'xl:h-[260px]'}" onclick="playTrackFromContext('search', 0)">

                        <img src="${topResult.cover || DEFAULT_COVER}" loading="lazy" decoding="async" class="w-20 h-20 sm:w-28 sm:h-28 ${isRightSidebarOpen ? '' : 'xl:w-28 xl:h-28'} rounded-full shadow-lg object-cover shrink-0" onerror="this.src='${DEFAULT_COVER}'">

                        <div class="flex flex-col justify-center overflow-hidden min-w-0 pr-10 w-full ${isRightSidebarOpen ? '' : 'xl:flex-1 xl:justify-end'}">
                            <h3 class="text-white text-[24px] ${isRightSidebarOpen ? '' : 'xl:text-[32px]'} font-bold text-truncate-safe mb-1 leading-tight tracking-tight">${topResult.title}</h3>
                            <div class="flex items-center gap-2 overflow-hidden w-full">
                                <span class="text-white text-[14px] font-medium hover:underline text-truncate-safe pointer-events-none md:pointer-events-auto" onclick="event.stopPropagation(); openArtistPlaylist('${safeArtist}')">${topResult.artist}</span>
                                <span class="bg-[#121212] text-white px-2 py-0.5 rounded-full text-[11px] font-bold shrink-0 uppercase tracking-wider ml-1">Música</span>
                            </div>
                        </div>

                        <button class="absolute bottom-5 right-5 w-12 h-12 rounded-full bg-[#1ed760] text-black flex items-center justify-center opacity-0 group-hover:opacity-100 transition hover:scale-105 hover:-translate-y-1 shadow-xl shrink-0 focus:outline-none translate-y-1">
                            <i class="ph-fill ph-play text-[22px] translate-x-[1px]"></i>
                        </button>
                    </div>
                </div>

                <div class="w-full flex-1 overflow-hidden min-w-0 filterable-item" data-type="tracks">
                    <h2 class="text-white text-2xl font-bold mb-4 tracking-tight">Músicas</h2>
                    <div class="flex flex-col w-full">${tracksHtml}</div>
                    ${displayList.length > limit ? `<button class="text-spotify-text hover:text-white font-bold text-sm mt-4 px-4 py-2 rounded-full border border-white/20 hover:border-white transition mx-auto block" onclick="loadMoreContent()">Mostrar Mais</button>` : ''}
                </div>
            </div>
        </div>
    `;

    setFilter(appState.currentFilter);
    updateActiveTrackUI();
}

// MUDANÇA: "Mostrar Mais" da busca também precisa ler de lastSearchResult
// agora (não mais de appState.queue), já que a busca não sequestra mais a
// fila só de exibir resultados.
function loadMoreContent() {
    appState.displayLimit += 12;
    if (currentView === 'search') {
        renderSearchResults(appState.lastSearchResult || [], document.getElementById('queryInput').value, false);
    } else if (currentView === 'playlist' || currentView.startsWith('artist_')) {
        const state = appState.history[appState.historyIndex];
        if (state.view === 'playlist') renderPlaylist(state.data);
        else if (state.view === 'artist_channel' || (state.view && state.view.startsWith && state.view.startsWith('artist'))) renderChannelTracksPage();
    }
}

// =============================================================================
// MUDANÇA: nome da playlist — limite de 32 caracteres na hora de criar/editar,
// e exibição SEM "...": o título grande encolhe sozinho até caber inteiro
// numa linha (nunca corta o nome, só diminui um pouco a fonte se precisar).
// Também: clicar no nome do "criador" da playlist agora funciona também nas
// SUAS PRÓPRIAS playlists (antes só funcionava em compartilhadas de outra
// pessoa) — leva pro seu próprio perfil público.
// =============================================================================
[['newPlaylistName', 32], ['newPlaylistNameMobile', 32], ['editPlaylistName', 32]].forEach(([id, max]) => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('maxlength', String(max));
});

function _fitTextToContainer(el) {
    if (!el) return;
    el.style.fontSize = '';
    let guard = 0;
    const minFont = 22;
    while (el.scrollWidth > el.clientWidth + 1 && guard < 40) {
        const current = parseFloat(getComputedStyle(el).fontSize);
        if (!current || current <= minFont) break;
        el.style.fontSize = (current - 2) + 'px';
        guard++;
    }
}
let _titleFitResizeBound = false;
function fitPlaylistTitle(el) {
    if (!el) return;
    requestAnimationFrame(() => _fitTextToContainer(el));
    if (!_titleFitResizeBound) {
        _titleFitResizeBound = true;
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => _fitTextToContainer(document.querySelector('.playlist-title-fit')), 150);
        });
    }
}

function renderPlaylist(playlistId) {
    const pl = appState.playlists.find(p => p.id === playlistId);
    if (!pl) return navigateTo('home');

    const colors = ['#4a3b8c', '#535353', '#8a2be2', '#e13300', '#1e3264'];
    const colorId = pl.id === 'liked' ? 0 : Math.abs(pl.name.charCodeAt(0) % colors.length);
    setHeaderColor(colors[colorId]);

    const count = pl.tracks ? pl.tracks.length : 0;
    const durText = calculatePlaylistDuration(pl.tracks);
    const isUserPl = pl.type === 'user';

    let tracksHtml = '';
    if (count === 0) {
        tracksHtml = `<div class="text-center text-spotify-text mt-16 fade-in"><h3 class="text-white text-xl font-bold mb-2">Vamos encontrar conteúdo para sua playlist</h3><button class="mt-4 bg-white text-black font-bold px-6 py-3 rounded-full hover:scale-105 transition" onclick="navigateTo('search')">Buscar Músicas</button> <button class="mt-4 bg-transparent border border-white text-white font-bold px-6 py-3 rounded-full hover:scale-105 transition ml-2" onclick="openImportModal()">Importar Mídia</button></div>`;
    } else {
        const limit = Math.min(pl.tracks.length, appState.displayLimit);
        for (let index = 0; index < limit; index++) {
            tracksHtml += generateTrackRow(pl.tracks[index], index, playlistId);
        }
        if (pl.tracks.length > limit) {
            tracksHtml += `<button class="text-spotify-text hover:text-white font-bold text-sm mt-4 px-4 py-2 rounded-full border border-white/20 hover:border-white transition mx-auto block" onclick="loadMoreContent()">Mostrar Mais</button>`;
        }
        warmTrackImages(pl.tracks);
    }

    let ownerName = currentUser ? (currentUser.displayName || 'Você') : 'Exlify';
    let isOwnerVerified = appState.verified;
    let onOwnerClick = "";

    if (pl.type === 'shared') {
        if (pl.ownerName) ownerName = pl.ownerName;
        if (pl.ownerVerified) isOwnerVerified = pl.ownerVerified;
        if (pl.ownerId) onOwnerClick = `onclick="navigateTo('profile', '${pl.ownerId}')"`;
    } else if (isUserPl && currentUser) {
        // Antes só era clicável em playlists compartilhadas de outra pessoa.
        onOwnerClick = `onclick="navigateTo('profile', '${currentUser.uid}')"`;
    }
    if (pl.type === 'youtube') ownerName = pl.owner || 'YouTube';

    let typeLabel = 'Playlist';
    if (pl.type === 'system') typeLabel = 'Playlist do Sistema';
    if (pl.type === 'shared') typeLabel = 'Playlist Compartilhada';
    if (pl.type === 'youtube') typeLabel = 'Playlist do YouTube';

    dom.viewContainer.innerHTML = `
        <div class="w-full max-w-[1500px] mx-auto flex flex-col">
            <button class="md:hidden w-8 h-8 rounded-full bg-black/50 flex items-center justify-center text-white mb-2 self-start focus:outline-none" onclick="goBack()"><i class="ph-bold ph-caret-left text-lg"></i></button>

            <div class="flex flex-col md:flex-row items-center md:items-end gap-6 mb-6 mt-2 fade-in text-center md:text-left w-full">
                <img src="${pl.cover || DEFAULT_COVER}" decoding="async" class="w-48 h-48 md:w-[232px] md:h-[232px] shadow-[0_4px_60px_rgba(0,0,0,0.5)] object-cover rounded shrink-0" onerror="this.src='${DEFAULT_COVER}'">
                <div class="w-full min-w-0">
                    <span class="text-[13px] font-bold text-white hidden md:block">${typeLabel} ${pl.isPublic ? '<i class="ph-bold ph-globe"></i> Pública' : ''}</span>
                    <h1 class="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black text-white mb-6 mt-2 tracking-tighter py-2 flex items-center justify-center md:justify-start gap-4 w-full">
                        <span class="playlist-title-fit flex-1 min-w-0">${pl.name}</span>
                        ${isUserPl ? `<button class="text-white/50 hover:text-white transition focus:outline-none shrink-0" onclick="openEditPlaylistModal('${pl.id}', '${pl.name.replace(/'/g, "\\'")}')"><i class="ph-bold ph-pencil-simple text-3xl"></i></button>` : ''}
                    </h1>
                    <div class="flex items-center justify-center md:justify-start gap-2 text-[14px] overflow-hidden w-full">
                        <div class="w-6 h-6 rounded-full shrink-0 bg-[#1ed760] flex items-center justify-center text-black font-bold text-[10px] uppercase">${ownerName.substring(0, 1)}</div>
                        <span class="text-white font-bold hover:underline cursor-pointer shrink-0 flex items-center" ${onOwnerClick}>${ownerName} ${getVerifiedHtml(isOwnerVerified)}</span>
                        <span class="text-white/80 font-medium before:content-['•'] before:mr-2 before:text-white shrink-0">${count} músicas${durText}</span>
                    </div>
                </div>
            </div>

            <div class="py-6 flex items-center justify-start gap-4 sm:gap-6 fade-in flex-wrap w-full">
                <button class="w-14 h-14 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-[1.04] transition shadow-lg focus:outline-none shrink-0" onclick="playContext('${pl.id}')">
                    <i class="ph-fill ph-play text-[24px] translate-x-[2px]"></i>
                </button>
                <button class="text-spotify-text hover:text-spotify-green transition focus:outline-none flex items-center justify-center shrink-0 tooltip" title="Ordem Aleatória" onclick="toggleShuffle(); this.querySelector('i').classList.toggle('text-spotify-green'); this.querySelector('i').classList.toggle('text-spotify-text');">
                    <i class="ph-bold ph-shuffle text-[32px] ${playerState.isShuffle ? 'text-spotify-green' : 'text-spotify-text'}"></i>
                </button>
                <button class="text-spotify-text hover:text-white transition focus:outline-none ml-2"><i class="ph-bold ph-heart text-[32px]"></i></button>
                ${pl.type !== 'system' && pl.type !== 'youtube' ? `<button class="text-spotify-text hover:text-white transition focus:outline-none" onclick="sharePlaylist('${pl.id}')"><i class="ph-bold ph-share-network text-3xl"></i></button>` : ''}
                ${pl.type !== 'system' && pl.type !== 'youtube' ? `<button class="text-spotify-text hover:text-white transition focus:outline-none" onclick="showDownloadInDevelopment()" title="Baixar"><i class="ph-bold ph-download-simple text-3xl"></i></button>` : ''}

                ${pl.id !== 'liked' ? `<button class="text-spotify-text hover:text-red-500 transition focus:outline-none ml-auto" onclick="deletePlaylist('${pl.id}')" title="Remover da Biblioteca"><i class="ph-bold ph-trash text-[30px]"></i></button>` : ''}
            </div>

            ${count > 0 ? `<div class="grid grid-cols-[30px_1fr_40px] md:grid-cols-[40px_4fr_3fr_minmax(120px,1fr)] gap-4 px-4 py-2 border-b border-white/10 text-sm text-spotify-text mb-4 sticky top-16 bg-[#121212]/95 backdrop-blur-sm z-10 font-medium fade-in hidden md:grid"><div class="text-center">#</div><div>Título</div><div>Álbum</div><div class="text-right flex items-center justify-end"><i class="ph-bold ph-clock text-[18px]"></i></div></div>` : ''}

            <div class="flex flex-col pb-20 fade-in w-full">${tracksHtml}</div>
        </div>
    `;
    fitPlaylistTitle(document.querySelector('.playlist-title-fit'));
    updateActiveTrackUI();
}

// =============================================================================
// MUDANÇA: corrige um bug real — clicar numa playlist pública no perfil de
// outra pessoa (sem ter salvado ela antes) te jogava direto pra Home sem
// aviso, porque a tela de playlist só sabia procurar em appState.playlists
// (sua própria biblioteca). Agora clicar no card abre uma prévia de verdade,
// com tudo funcionando (tocar, ver faixas, clicar no nome do dono pra ir pro
// perfil dele) mesmo sem ter salvado — igual o botão "Salvar" já permitia
// guardar, só que agora dá pra OUVIR/OLHAR antes de decidir salvar.
// =============================================================================
let _foreignPreviewTracks = [];
let _foreignPreviewId = '';
let _foreignPreviewName = '';

function previewForeignPlaylist(pl, ownerName, ownerUid, ownerVerified) {
    // Se você já tem essa playlist salva na sua biblioteca, mostra a SUA
    // cópia normalmente (editar, tocar etc. tudo funcionando de verdade).
    const owned = appState.playlists.find(p => p.id === pl.id);
    if (owned) { navigateTo('playlist', pl.id); return; }

    setHeaderColor('#2a2a2a');
    _foreignPreviewTracks = pl.tracks || [];
    _foreignPreviewId = pl.id;
    _foreignPreviewName = pl.name;
    const contextKey = 'foreign_' + pl.id;

    const count = _foreignPreviewTracks.length;
    const durText = calculatePlaylistDuration(_foreignPreviewTracks);

    let tracksHtml = '';
    if (count === 0) {
        tracksHtml = `<div class="text-center text-spotify-text mt-16 fade-in"><h3 class="text-white text-xl font-bold mb-2">Essa playlist ainda não tem músicas</h3></div>`;
    } else {
        _foreignPreviewTracks.forEach((t, i) => { tracksHtml += generateTrackRow(t, i, contextKey); });
        warmTrackImages(_foreignPreviewTracks);
    }

    const safeOwnerName = (ownerName || 'Usuário').replace(/</g, '&lt;');
    const safePl = JSON.stringify(pl).replace(/"/g, '&quot;');

    dom.viewContainer.innerHTML = `
        <div class="w-full max-w-[1500px] mx-auto flex flex-col">
            <button class="md:hidden w-8 h-8 rounded-full bg-black/50 flex items-center justify-center text-white mb-2 self-start focus:outline-none" onclick="goBack()"><i class="ph-bold ph-caret-left text-lg"></i></button>

            <div class="flex flex-col md:flex-row items-center md:items-end gap-6 mb-6 mt-2 fade-in text-center md:text-left w-full">
                <img src="${pl.cover || DEFAULT_COVER}" decoding="async" class="w-48 h-48 md:w-[232px] md:h-[232px] shadow-[0_4px_60px_rgba(0,0,0,0.5)] object-cover rounded shrink-0" onerror="this.src='${DEFAULT_COVER}'">
                <div class="w-full min-w-0">
                    <span class="text-[13px] font-bold text-white hidden md:block">Playlist Pública</span>
                    <h1 class="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black text-white mb-6 mt-2 tracking-tighter py-2 flex items-center justify-center md:justify-start gap-4 w-full">
                        <span class="playlist-title-fit flex-1 min-w-0">${pl.name}</span>
                    </h1>
                    <div class="flex items-center justify-center md:justify-start gap-2 text-[14px] overflow-hidden w-full">
                        <div class="w-6 h-6 rounded-full shrink-0 bg-[#1ed760] flex items-center justify-center text-black font-bold text-[10px] uppercase">${safeOwnerName.substring(0, 1)}</div>
                        <span class="text-white font-bold hover:underline cursor-pointer shrink-0 flex items-center" onclick="navigateTo('profile', '${ownerUid}')">${safeOwnerName} ${getVerifiedHtml(ownerVerified)}</span>
                        <span class="text-white/80 font-medium before:content-['•'] before:mr-2 before:text-white shrink-0">${count} músicas${durText}</span>
                    </div>
                </div>
            </div>

            <div class="py-6 flex items-center justify-start gap-4 sm:gap-6 fade-in flex-wrap w-full">
                ${count > 0 ? `<button class="w-14 h-14 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-[1.04] transition shadow-lg focus:outline-none shrink-0" onclick="playTrackFromContext('${contextKey}', 0)"><i class="ph-fill ph-play text-[24px] translate-x-[2px]"></i></button>` : ''}
                <button class="border border-white/50 text-white font-bold text-xs uppercase tracking-wider px-6 py-3 rounded-full hover:border-white hover:scale-105 transition focus:outline-none" onclick="saveSharedPlaylist('${pl.id}', ${safePl})">Salvar na Biblioteca</button>
            </div>

            <div class="flex flex-col pb-20 fade-in w-full">${tracksHtml}</div>
        </div>
    `;
    fitPlaylistTitle(document.querySelector('.playlist-title-fit'));
    updateActiveTrackUI();
}

async function renderUserProfile(userId) {
    setHeaderColor('#2a2a2a');
    dom.viewContainer.innerHTML = `<div class="animate-pulse w-full h-40 bg-[#282828] rounded mt-12 max-w-4xl mx-auto"></div>`;

    try {
        let userData = null;
        if (userId.startsWith('mock_')) {
            userData = { name: 'Usuário Teste', uid: userId, verified: true, playlists: [{ id: 'p1', name: 'Sertanejo Pub', type: 'shared', cover: DEFAULT_COVER, tracks: [] }] };
        } else {
            const docRef = db.collection('artifacts').doc('exlifyApp').collection('public').doc('data').collection('users').doc(userId);
            const snap = await docRef.get();
            if (snap.exists) userData = snap.data();
        }

        if (!userData) {
            dom.viewContainer.innerHTML = `<h2 class="text-white text-2xl font-bold mt-12 text-center">Perfil não encontrado.</h2>`;
            return;
        }

        let plHtml = '';
        if (userData.playlists && userData.playlists.length > 0) {
            userData.playlists.forEach(pl => {
                pl.ownerId = userData.uid;
                pl.ownerVerified = userData.verified;

                const safeOwnerNameJs = (userData.name || 'Usuário').replace(/'/g, "\\'");
                plHtml += `
                    <div class="bg-[#181818] hover:bg-[#282828] p-4 rounded-lg transition cursor-pointer group flex flex-col card-hover-lift" onclick="previewForeignPlaylist(${JSON.stringify(pl).replace(/"/g, '&quot;')}, '${safeOwnerNameJs}', '${userData.uid}', ${!!userData.verified})">
                        <img src="${pl.cover || DEFAULT_COVER}" class="w-full aspect-square rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.5)] mb-4 object-cover">
                        <h3 class="text-white font-bold mb-1 truncate text-[15px]">${pl.name}</h3>
                        <p class="text-[13px] text-spotify-text mb-3 flex items-center">De ${userData.name} ${getVerifiedHtml(userData.verified)}</p>
                        <button class="mt-auto border border-white/50 text-white font-bold text-xs uppercase px-4 py-1.5 rounded-full hover:border-white hover:scale-105 transition" onclick="event.stopPropagation(); saveSharedPlaylist('${pl.id}', ${JSON.stringify(pl).replace(/"/g, '&quot;')})">Salvar</button>
                    </div>
                `;
            });
        } else {
            plHtml = `<p class="text-spotify-text">Este usuário não tem playlists públicas no momento.</p>`;
        }

        const verifBadgeBig = getVerifiedHtml(userData.verified).replace('text-[10px]', 'text-lg').replace('w-16 h-16', 'w-8 h-8');

        dom.viewContainer.innerHTML = `
            <div class="w-full max-w-[1500px] mx-auto flex flex-col fade-in">
                <button class="md:hidden w-8 h-8 rounded-full bg-black/50 flex items-center justify-center text-white mb-2 self-start focus:outline-none" onclick="goBack()"><i class="ph-bold ph-caret-left text-lg"></i></button>

                <div class="mt-4 mb-10 flex flex-col md:flex-row items-center md:items-end gap-6">
                    ${userData.profileImage ?
                        `<img src="${userData.profileImage}" class="w-48 h-48 md:w-[232px] md:h-[232px] rounded-full object-cover shadow-[0_4px_60px_rgba(0,0,0,0.5)] shrink-0">` :
                        `<div class="w-48 h-48 md:w-[232px] md:h-[232px] rounded-full overflow-hidden shadow-[0_4px_60px_rgba(0,0,0,0.5)] bg-[#333] flex items-center justify-center text-7xl font-bold text-white shrink-0">
                            ${(userData.name || 'U').substring(0, 1).toUpperCase()}
                        </div>`
                    }
                    <div class="flex-1 text-center md:text-left min-w-0 w-full">
                        <span class="text-sm font-bold text-white uppercase tracking-wider mb-2 block">Perfil</span>
                        <h1 class="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black text-white mb-4 tracking-tighter flex items-center justify-center md:justify-start gap-4 w-full">
                            <span class="playlist-title-fit flex-1 min-w-0">${userData.name}</span>
                            ${userData.verified ? '<span class="bg-blue-500 text-white rounded-full w-10 h-10 flex items-center justify-center shadow-lg shrink-0"><i class="ph-bold ph-check text-2xl"></i></span>' : ''}
                        </h1>
                        <button class="text-spotify-text text-sm font-medium hover:text-white transition focus:outline-none flex items-center justify-center md:justify-start gap-2" onclick="navigator.clipboard.writeText(window.location.href.split('?')[0] + '?user=${userData.uid}').then(()=>showToast('Link do perfil copiado!'))">
                            <i class="ph-bold ph-link text-lg"></i> Copiar link do perfil
                        </button>
                    </div>
                </div>

                <h2 class="text-white text-2xl font-bold mb-6 tracking-tight">Playlists Públicas</h2>
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                    ${plHtml}
                </div>
            </div>
        `;
        fitPlaylistTitle(document.querySelector('.playlist-title-fit'));
    } catch (e) { console.log(e); dom.viewContainer.innerHTML = `<h2 class="text-white text-2xl text-center mt-12">Erro ao carregar perfil.</h2>`; }
}

// =============================================================================
// MUDANÇA: "Tocando Agora" já abre direto como janela de verdade (Picture-in-
// Picture — flutua por cima de QUALQUER janela/app, não só dentro da aba),
// em vez de abrir primeiro dentro da página e exigir um segundo clique num
// ícone pequeno pra "pop-out". Continua 100% sincronizada com o player do
// site (é o mesmo elemento sendo movido, o áudio nunca para) e responsiva a
// qualquer tamanho que o usuário arrastar a janela do SO (isso já existia,
// só ampliamos as faixas de tamanho no CSS). Se o navegador não suportar
// janela real (ex: Firefox, Safari), cai de volta pro card dentro da página
// normalmente — ninguém fica sem o recurso.
// =============================================================================
function toggleNowPlayingCard() {
    const card = document.getElementById('nowPlayingCard');
    if (!card) return;

    const isOpenInPage = card.classList.contains('flex') && !_pipWindow;
    if (isOpenInPage) {
        card.classList.remove('flex');
        card.classList.add('hidden');
        return;
    }
    if (_pipWindow) { _pipWindow.focus(); return; }

    if ('documentPictureInPicture' in window) {
        popOutFloatingPlayer();
        return;
    }

    // Sem suporte a janela real — usa o card dentro da página (comportamento original)
    card.classList.remove('hidden');
    card.classList.add('flex');
    updateNowPlayingCardUI();
}

// =============================================================================
// MUDANÇA: foto de perfil do header nunca mais fica "quebrada" — se o link
// da imagem falhar (removida do host, sem internet no momento, etc.), volta
// pro ícone genérico sozinha em vez de mostrar o ícone de imagem quebrada do
// navegador (que, empilhado com o ícone de usuário, é o que causava aquele
// visual estranho de "metade ícone, metade foto").
// =============================================================================
function updateProfileHeaderUI() {
    const icon = document.getElementById('headerProfileIcon');
    const img = document.getElementById('headerProfileImg');
    if (!icon || !img) return;

    img.onerror = () => {
        img.classList.add('hidden');
        icon.classList.remove('hidden');
    };

    if (appState.profileImage) {
        img.src = appState.profileImage;
        icon.classList.add('hidden');
        img.classList.remove('hidden');
    } else if (currentUser) {
        icon.classList.add('hidden');
        img.classList.add('hidden');
        icon.classList.remove('hidden');
        icon.innerText = (currentUser.displayName || 'U').substring(0, 1).toUpperCase();
    } else {
        img.classList.add('hidden');
        icon.classList.remove('hidden');
        icon.innerText = '';
        icon.className = 'ph-bold ph-user text-base';
    }
}

// =============================================================================
// MUDANÇA: compressão de imagem melhorada — tenta gerar WebP (bem mais leve
// que JPEG na mesma qualidade visual) antes de subir foto de perfil ou capa
// de playlist; se o navegador não conseguir gerar WebP, cai pro JPEG de
// sempre automaticamente. Reduz o tanto de dado que cada envio consome sem
// mudar nada visualmente pro usuário.
// =============================================================================
function compressImageFile(file, { maxSize = 512, quality = 0.6 } = {}) {
    return new Promise((resolve) => {
        if (file.type === 'image/gif') return resolve(file);

        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            let { width, height } = img;
            if (width > height && width > maxSize) {
                height = Math.round(height * (maxSize / width));
                width = maxSize;
            } else if (height > maxSize) {
                width = Math.round(width * (maxSize / height));
                height = maxSize;
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            const finishWith = (blob, ext, type) => {
                if (!blob) return resolve(file);
                resolve(new File([blob], (file.name || 'image').replace(/\.[^.]+$/, '') + ext, { type }));
            };

            canvas.toBlob((webpBlob) => {
                // Confirma que o navegador gerou WebP de verdade (alguns
                // devolvem um PNG/JPEG silenciosamente quando não suportam).
                if (webpBlob && webpBlob.type === 'image/webp' && webpBlob.size > 0) {
                    finishWith(webpBlob, '.webp', 'image/webp');
                } else {
                    canvas.toBlob((jpgBlob) => finishWith(jpgBlob, '.jpg', 'image/jpeg'), 'image/jpeg', quality);
                }
            }, 'image/webp', quality);
        };
        img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); };
        img.src = objectUrl;
    });
}

// =============================================================================
// MUDANÇA: pré-conecta com os domínios de imagem/upload mais usados assim
// que a página carrega (DNS + handshake feitos ANTES de precisar da imagem),
// pra thumbnails/capas aparecerem mais rápido. Não mexe em /search nem
// /get-audio (mesma origem do próprio site, não precisa de preconnect).
// =============================================================================
(function preconnectHints() {
    const domains = ['https://i.ytimg.com', 'https://api.imgbb.com', 'https://i.ibb.co', 'https://placehold.co'];
    domains.forEach(href => {
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = href;
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
    });
})();

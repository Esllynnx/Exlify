// API KEY PARA IMGBB
    const IMGBB_API_KEY = "753a069314b2b06edaef1e8bcd5fc9ea";

    // --- FIREBASE CONFIG & INIT (INTACTO) ---
    const firebaseConfig = {
        apiKey: "AIzaSyBTfa9oAI0ER8C8DEckr9y4_uVJZIUBCXg",
        authDomain: "exlynnx-pro.firebaseapp.com",
        projectId: "exlynnx-pro",
        storageBucket: "exlynnx-pro.firebasestorage.app",
        messagingSenderId: "264446172696",
        appId: "1:264446172696:web:5a93c9d250c895da96ed6d",
        measurementId: "G-CHBHBKT9DX"
    };
    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    const db = firebase.firestore();
    let currentUser = null;

    // --- DATA & STATE MANAGEMENT (COM TEMA, LIMITES E VERIFICADO) ---
    let appState = {
        likedSongs: [],
        playlists: [{ id: 'liked', name: 'Músicas Curtidas', type: 'system', cover: 'https://misc.scdn.co/liked-songs/liked-songs-640.png', tracks: [] }],
        followedArtists: [],
        queue: [], queueContext: '', currentTrackIndex: -1,
        history: [], historyIndex: -1, recentSearches: [], recentlyPlayed: [],
        currentFilter: 'all',
        theme: 'dark',
        displayLimit: 12,
        profileImage: null,
        verified: false, // Novo campo
        leftWidth: 380, // Padrão
        rightWidth: 380, // Padrão
        settings: { reduceMotion: false, dataSaver: false }
    };

    const DEFAULT_COVER = 'https://placehold.co/120x120/282828/b3b3b3?text=Audio';
    const viewScrollStates = { home: 0, search: 0, library: 0, playlist: {} };

    // =========================================================================
    // CAMADA DE PERFORMANCE — só acelera a EXIBIÇÃO de metadados/imagens.
    // Não interfere em /search nem em /get-audio (rotas de áudio 100% intactas).
    // =========================================================================
    const PERF = {
        searchCache: new Map(),      // query -> { videos, ts }
        SEARCH_CACHE_TTL: 5 * 60 * 1000, // 5 minutos
        warmedImages: new Set(),     // urls de thumbnail já pré-aquecidas no cache do navegador
        currentSearchAbort: null,    // AbortController da busca em andamento
        idle(fn) {
            if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 1000 });
            else setTimeout(fn, 0);
        }
    };

    // Pré-aquece uma imagem no cache HTTP do navegador sem bloquear a thread principal.
    function warmImage(url) {
        if (!url || PERF.warmedImages.has(url) || url.startsWith('https://placehold.co')) return;
        PERF.warmedImages.add(url);
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
    }

    // Pré-aquece as capas de uma lista de faixas/itens (thumbnails), em segundo plano.
    function warmTrackImages(items) {
        if (!items || items.length === 0) return;
        if (appState.settings && appState.settings.dataSaver) return; // Economia de dados: pula pré-carregamento
        PERF.idle(() => {
            items.slice(0, 40).forEach(it => warmImage(it.cover || it.thumbnail));
        });
    }

    // Normaliza uma query de busca para usar como chave de cache
    function normalizeQueryKey(q) { return (q || '').trim().toLowerCase(); }

    // Guarda um resultado de busca no cache em memória (metadados: título, artista, capa, duração — nunca áudio)
    function cacheSearchResult(query, videos) {
        PERF.searchCache.set(normalizeQueryKey(query), { videos, ts: Date.now() });
    }

    // Recupera um resultado de busca do cache, se ainda válido
    function getCachedSearchResult(query) {
        const entry = PERF.searchCache.get(normalizeQueryKey(query));
        if (!entry) return null;
        if (Date.now() - entry.ts > PERF.SEARCH_CACHE_TTL) return null;
        return entry.videos;
    }

    // DADOS ESTÁTICOS INICIAIS
    let topTrendingData = [];
    let isTrendingLoaded = false;

    async function loadTrendingFromYouTube() {
        try {
            const response = await fetch('/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: 'top hits musicas mais tocadas brasil' })
            });
            if (response.ok) {
                const data = await response.json();
                if (data.videos && data.videos.length > 0) {
                    topTrendingData = data.videos.slice(0, 10).map((v, i) => ({
                        id: v.url || `trend_${i}`, 
                        title: v.title, 
                        artist: v.artist || (v.author && v.author.name) || 'Artista',
                        cover: v.thumbnail || DEFAULT_COVER, 
                        url: v.url, 
                        duration: v.duration || '0:00'
                    }));
                }
            }
        } catch (e) { 
            console.error("Usando trending de fallback", e); 
            topTrendingData = [
                { id: 't1', title: 'Espresso', artist: 'Sabrina Carpenter', cover: 'https://placehold.co/120x120/121212/fff?text=Espresso', url: 'mock_t1', duration: '2:55' },
                { id: 't2', title: 'Too Sweet', artist: 'Hozier', cover: 'https://placehold.co/120x120/121212/fff?text=Too+Sweet', url: 'mock_t2', duration: '4:11' },
                { id: 't3', title: 'Beautiful Things', artist: 'Benson Boone', cover: 'https://placehold.co/120x120/121212/fff?text=Beautiful', url: 'mock_t3', duration: '3:00' },
                { id: 't4', title: 'Lose Control', artist: 'Teddy Swims', cover: 'https://placehold.co/120x120/121212/fff?text=Lose', url: 'mock_t4', duration: '3:30' }
            ];
        }
        isTrendingLoaded = true;
        warmTrackImages(topTrendingData);
        if(currentView === 'home') renderHome();
    }

    async function loadData() {
        try {
            // Carrega tamanhos do localStorage sempre
            const storedWidths = localStorage.getItem('exlify_widths');
            if(storedWidths) {
                const parsedW = JSON.parse(storedWidths);
                appState.leftWidth = parsedW.left || 380;
                appState.rightWidth = parsedW.right || 380;
            }
            applySidebarWidths();

            if (currentUser) {
                const docRef = db.collection('artifacts').doc('exlifyApp').collection('users').doc(currentUser.uid).collection('userData').doc('state');
                const snap = await docRef.get();
                if (snap.exists) {
                    const cloudData = snap.data();
                    appState.likedSongs = cloudData.likedSongs || [];
                    appState.followedArtists = cloudData.followedArtists || [];
                    appState.recentSearches = cloudData.recentSearches || [];
                    appState.theme = cloudData.theme || 'dark';
                    appState.profileImage = cloudData.profileImage || null;
                    appState.verified = cloudData.verified || false;
                    
                    const savedPlaylists = cloudData.playlists || [];
                    const likedList = savedPlaylists.find(p => p.id === 'liked');
                    if(likedList) likedList.tracks = appState.likedSongs;
                    if(savedPlaylists.length === 0) savedPlaylists.push({ id: 'liked', name: 'Músicas Curtidas', type: 'system', cover: 'https://misc.scdn.co/liked-songs/liked-songs-640.png', tracks: appState.likedSongs });
                    appState.playlists = savedPlaylists;
                }
            } else {
                const stored = localStorage.getItem('exlify_data');
                if (stored) {
                    const parsed = JSON.parse(stored);
                    appState.likedSongs = parsed.likedSongs || [];
                    appState.recentSearches = parsed.recentSearches || [];
                    appState.followedArtists = parsed.followedArtists || [];
                    appState.theme = parsed.theme || 'dark';
                    appState.profileImage = parsed.profileImage || null;
                    const savedPlaylists = parsed.playlists || [];
                    const likedList = savedPlaylists.find(p => p.id === 'liked');
                    if(likedList) likedList.tracks = appState.likedSongs;
                    appState.playlists = savedPlaylists;
                }
            }
            
            applyTheme(appState.theme);
            updateProfileHeaderUI();
            
            const urlParams = new URLSearchParams(window.location.search);
            const sharedId = urlParams.get('shared_pl');
            
            if (sharedId) {
                db.collection('shared_playlists').doc(sharedId).get().then(doc => {
                    if (doc.exists) {
                        const sharedPl = doc.data();
                        sharedPl.type = 'shared'; 
                        if (!appState.playlists.find(p => p.id === sharedId)) {
                            appState.playlists.push(sharedPl);
                            showSharedPlaylistPrompt(sharedPl);
                        } else {
                            navigateTo('playlist', sharedId);
                        }
                    }
                }).catch(e => console.log('Sem acesso ou não existe playlist comp: ', e));
            }

            const profileId = urlParams.get('user');
            if (profileId) {
                setTimeout(() => renderUserProfile(profileId), 500);
            }

            renderSidebar();
            
            try {
                const st = localStorage.getItem('exlify_settings');
                if (st) appState.settings = { ...appState.settings, ...JSON.parse(st) };
            } catch(e) {}

            try {
                const rp = localStorage.getItem('exlify_recently_played');
                if (rp) appState.recentlyPlayed = JSON.parse(rp);
            } catch(e) {}

            const lastPlayedStr = localStorage.getItem('exlify_last_played');
            if (lastPlayedStr) {
                try {
                    const lp = JSON.parse(lastPlayedStr);
                    if(lp.track && lp.context) {
                        appState.queueContext = lp.context;
                        appState.queue = lp.queue || [lp.track];
                        appState.currentTrackIndex = lp.index || 0;
                        setPlayerUIToTrack(lp.track);
                    }
                } catch(e) {}
            }

            if(currentView === 'home' && !sharedId) renderHome();
            if(currentView === 'library') renderLibraryMobile();
            
            loadTrendingFromYouTube();
        } catch(e) { console.error("Error loading data", e); }
    }

    // --- SISTEMA DE PROMPT DE PLAYLIST ---
    let tempSharedPlId = null;
    function showSharedPlaylistPrompt(pl) {
        tempSharedPlId = pl.id;
        document.getElementById('sharedPromptCover').src = pl.cover || DEFAULT_COVER;
        document.getElementById('sharedPromptName').innerText = pl.name;
        
        const modal = document.getElementById('sharedPlaylistPromptModal');
        modal.classList.remove('hidden');
        setTimeout(() => { modal.classList.remove('opacity-0'); modal.firstElementChild.classList.remove('scale-95'); }, 10);
    }
    
    function handleSharedPrompt(action) {
        const modal = document.getElementById('sharedPlaylistPromptModal');
        modal.classList.add('opacity-0'); modal.firstElementChild.classList.add('scale-95');
        setTimeout(() => modal.classList.add('hidden'), 200);
        
        if (action === 'save') {
            if (!currentUser) {
                showToast("Faça login para salvar permanentemente.");
                openAuthModal();
            } else {
                saveData();
                showToast("Playlist salva na sua biblioteca!");
            }
        } else {
            showToast("Modo visualização. A lista sairá ao recarregar a página.");
        }
        navigateTo('playlist', tempSharedPlId);
    }

    async function saveData() {
        try {
            const likedList = appState.playlists.find(p => p.id === 'liked');
            if (likedList) likedList.tracks = appState.likedSongs;
            
            const exportState = {
                likedSongs: appState.likedSongs,
                playlists: appState.playlists,
                recentSearches: appState.recentSearches,
                followedArtists: appState.followedArtists,
                theme: appState.theme,
                profileImage: appState.profileImage,
                verified: appState.verified
            };

            if (currentUser) {
                await db.collection('artifacts').doc('exlifyApp').collection('users').doc(currentUser.uid).collection('userData').doc('state').set(exportState);
                
                const publicPlaylists = appState.playlists.filter(p => p.isPublic === true);
                await db.collection('artifacts').doc('exlifyApp').collection('public').doc('data').collection('users').doc(currentUser.uid).set({
                    name: currentUser.displayName || 'Usuário Exlify',
                    uid: currentUser.uid,
                    profileImage: appState.profileImage || null,
                    playlists: publicPlaylists,
                    verified: appState.verified // Manter verificado público
                }, { merge: true });
            } else {
                localStorage.setItem('exlify_data', JSON.stringify(exportState));
            }
            renderSidebar(); 
        } catch(e) { console.error("Error saving data", e); }
    }
    
    function saveLastPlayed(track) {
        try {
            localStorage.setItem('exlify_last_played', JSON.stringify({
                track: track,
                context: appState.queueContext,
                index: appState.currentTrackIndex,
                queue: appState.queue
            }));
        } catch(e) {}
        trackRecentlyPlayed(track);
    }

    // Mantém uma lista curta de "Tocadas recentemente" para a Home (só bookkeeping/UI,
    // não interfere em nada da extração/reprodução de áudio).
    function trackRecentlyPlayed(track) {
        if (!track || !track.id) return;
        appState.recentlyPlayed = appState.recentlyPlayed.filter(t => t.id !== track.id);
        appState.recentlyPlayed.unshift(track);
        if (appState.recentlyPlayed.length > 12) appState.recentlyPlayed.pop();
        try { localStorage.setItem('exlify_recently_played', JSON.stringify(appState.recentlyPlayed)); } catch(e) {}
    }

    function playFromRecentlyPlayed(index) {
        appState.queueContext = 'recentlyPlayed';
        appState.queue = [...appState.recentlyPlayed];
        playTrackFromContext('recentlyPlayed', index);
    }

    // --- SISTEMA DE TEMAS E REDIMENSIONAMENTO ---
    function applyTheme(themeName, btnElement = null) {
        appState.theme = themeName;
        document.body.className = `h-screen flex flex-col overflow-hidden text-sm font-sans no-select bg-black theme-${themeName} relative`;
        if (appState.settings && appState.settings.reduceMotion) document.body.classList.add('reduce-motion');
        
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.remove('border-white');
            btn.classList.add('border-transparent');
        });
        if(btnElement) {
            btnElement.classList.add('border-white');
            btnElement.classList.remove('border-transparent');
        } else {
            const btns = document.querySelectorAll('.theme-btn');
            if(btns.length > 0) {
                let index = 0;
                if(themeName === 'blue') index = 1;
                if(themeName === 'green') index = 2;
                if(themeName === 'wine') index = 3;
                btns[index].classList.add('border-white');
                btns[index].classList.remove('border-transparent');
            }
        }
        saveData();
    }

    // =========================================================================
    // NOVAS CONFIGURAÇÕES: economia de dados, reduzir animações, cache de imagens
    // =========================================================================
    function toggleReduceMotion(checked) {
        appState.settings.reduceMotion = checked;
        document.body.classList.toggle('reduce-motion', checked);
        try { localStorage.setItem('exlify_settings', JSON.stringify(appState.settings)); } catch(e) {}
    }

    function toggleDataSaver(checked) {
        appState.settings.dataSaver = checked;
        try { localStorage.setItem('exlify_settings', JSON.stringify(appState.settings)); } catch(e) {}
        showToast(checked ? "Economia de dados ativada: pré-carregamento de capas desligado." : "Economia de dados desativada.");
    }

    async function clearImageCache() {
        try {
            PERF.warmedImages.clear();
            PERF.searchCache.clear();
            if ('caches' in window) {
                await caches.delete('exlify-images-v1');
            }
            showToast("Cache de imagens e buscas limpo.");
        } catch(e) {
            showToast("Não foi possível limpar o cache.");
        }
    }

    // INIT REDIMENSIONAMENTO E UI DE IMPORTAÇÃO (Executado no load)
    function setupAppInjections() {
        // 1. Injetar barras de redimensionamento
        const leftNav = document.querySelector('nav');
        const mainArea = document.querySelector('main');
        const rightNav = document.getElementById('rightSidebar');

        if(leftNav && mainArea) {
            const leftResizer = document.createElement('div');
            leftResizer.className = 'resizer-left hidden md:block';
            leftNav.parentNode.insertBefore(leftResizer, mainArea);

            let isResizingLeft = false;
            leftResizer.addEventListener('mousedown', (e) => {
                isResizingLeft = true;
                document.body.style.cursor = 'col-resize';
                leftResizer.classList.add('active');
            });
            window.addEventListener('mousemove', (e) => {
                if(!isResizingLeft) return;
                let newWidth = e.clientX;
                if(newWidth < 200) newWidth = 200;
                if(newWidth > 600) newWidth = 600;
                appState.leftWidth = newWidth;
                leftNav.style.width = `${newWidth}px`;
            });
            window.addEventListener('mouseup', () => {
                if(isResizingLeft) {
                    isResizingLeft = false;
                    document.body.style.cursor = '';
                    leftResizer.classList.remove('active');
                    localStorage.setItem('exlify_widths', JSON.stringify({left: appState.leftWidth, right: appState.rightWidth}));
                }
            });
        }

        if(rightNav && mainArea) {
            const rightResizer = document.createElement('div');
            rightResizer.className = 'resizer-right hidden md:block';
            rightNav.parentNode.insertBefore(rightResizer, rightNav);

            let isResizingRight = false;
            rightResizer.addEventListener('mousedown', (e) => {
                isResizingRight = true;
                document.body.style.cursor = 'col-resize';
                rightResizer.classList.add('active');
            });
            window.addEventListener('mousemove', (e) => {
                if(!isResizingRight) return;
                let newWidth = window.innerWidth - e.clientX;
                if(newWidth < 250) newWidth = 250;
                if(newWidth > 600) newWidth = 600;
                appState.rightWidth = newWidth;
                rightNav.style.width = `${newWidth}px`;
            });
            window.addEventListener('mouseup', () => {
                if(isResizingRight) {
                    isResizingRight = false;
                    document.body.style.cursor = '';
                    rightResizer.classList.remove('active');
                    localStorage.setItem('exlify_widths', JSON.stringify({left: appState.leftWidth, right: appState.rightWidth}));
                }
            });
        }

        // 2. Modificar o Modal de Importação para CSV
        const importContent = document.getElementById('importLinkContent');
        if(importContent) {
            importContent.innerHTML = `
                <h2 class="text-white text-xl font-bold mb-4 flex items-center gap-2"><i class="ph-bold ph-download-simple text-spotify-green"></i> Importar Playlist</h2>
                
                <!-- Aba Link -->
                <div class="mb-4">
                    <p class="text-spotify-text text-sm mb-2">Cole o link (YouTube) para importar.</p>
                    <input type="text" id="importLinkInput" class="w-full bg-[#3e3e3e] text-white p-3 rounded text-[15px] mb-2 focus:outline-none focus:ring-2 focus:ring-spotify-green placeholder-white/50" placeholder="https://youtube.com/watch?v=... ou list=...">
                </div>

                <div class="w-full h-[1px] bg-white/10 my-4 relative flex justify-center items-center">
                    <span class="bg-[#282828] px-3 text-xs font-bold uppercase tracking-widest text-white/50">OU</span>
                </div>

                <!-- Aba CSV Spotify -->
                <div class="mb-6">
                    <p class="text-spotify-text text-sm mb-2">Envie um CSV exportado do Spotify (Colunas: Nome da música, Artista).</p>
                    <label class="w-full flex items-center justify-center gap-2 bg-[#3e3e3e] hover:bg-[#4a4a4a] text-white text-sm font-bold py-3 px-4 rounded cursor-pointer transition border border-white/10 border-dashed">
                        <i class="ph-bold ph-file-csv text-xl"></i> Selecionar CSV
                        <input type="file" class="hidden" accept=".csv" id="importCsvInput" onchange="handleCsvFileSelect(event)">
                    </label>
                    <p id="csvFileName" class="text-xs text-spotify-green mt-2 hidden truncate"></p>
                </div>

                <label class="block text-spotify-text text-xs mb-2 uppercase font-bold tracking-wider">Salvar na sua Playlist</label>
                <select id="importPlaylistSelect" class="w-full bg-[#3e3e3e] text-white p-3 rounded text-[15px] mb-6 focus:outline-none focus:ring-2 focus:ring-spotify-green"></select>

                <div class="flex justify-end gap-4 font-bold text-sm">
                    <button class="px-4 py-2 text-white hover:scale-105 transition focus:outline-none" onclick="closeImportModal()">Cancelar</button>
                    <button class="px-6 py-2 bg-spotify-green text-black rounded-full hover:scale-105 transition focus:outline-none" onclick="importMediaProcess()">Importar</button>
                </div>
            `;
        }
    }
    
    document.addEventListener("DOMContentLoaded", setupAppInjections);

    function applySidebarWidths() {
        const leftNav = document.querySelector('nav');
        const rightNav = document.getElementById('rightSidebar');
        if(leftNav) leftNav.style.width = `${appState.leftWidth}px`;
        if(rightNav) rightNav.style.width = `${appState.rightWidth}px`;
    }

    function getVerifiedHtml(isVerified) {
        if(isVerified) return `<span class="verified-badge" title="Verificado"><i class="ph-bold ph-check text-[10px]"></i></span>`;
        return '';
    }

    // --- UPLOAD PARA IMGBB ---
    async function uploadToImgBB(file) {
        const formData = new FormData();
        formData.append('image', file);
        try {
            const res = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, { method: 'POST', body: formData });
            const data = await res.json();
            return data.data.url;
        } catch(e) {
            showToast("Erro ao fazer upload da imagem.");
            return null;
        }
    }

    // --- NOVO MENU DE PERFIL & CONFIGURAÇÕES ---
    let isProfileMenuOpen = false;
    function updateProfileHeaderUI() {
        const icon = document.getElementById('headerProfileIcon');
        const img = document.getElementById('headerProfileImg');
        
        if(appState.profileImage) {
            icon.classList.add('hidden');
            img.src = appState.profileImage;
            img.classList.remove('hidden');
        } else if (currentUser) {
            img.classList.add('hidden');
            icon.classList.remove('hidden', 'ph-user');
            icon.classList.add('not-italic', 'font-sans');
            icon.innerText = (currentUser.displayName || currentUser.email || 'U').substring(0,1).toUpperCase();
        } else {
            img.classList.add('hidden');
            icon.classList.remove('hidden', 'not-italic', 'font-sans');
            icon.classList.add('ph-user');
            icon.innerText = '';
        }
    }

    function toggleProfileMenu() {
        isProfileMenuOpen = !isProfileMenuOpen;
        const menu = document.getElementById('profileDropdownMenu');
        if(isProfileMenuOpen) {
            menu.classList.remove('hidden');
            
            if(currentUser) {
                const verifiedIcon = getVerifiedHtml(appState.verified);
                menu.innerHTML = `
                    <div class="px-3 py-2 border-b border-white/10 mb-1 flex items-center gap-3">
                        ${appState.profileImage ? `<img src="${appState.profileImage}" class="w-10 h-10 rounded-full object-cover">` : `<div class="w-10 h-10 rounded-full bg-spotify-green text-black flex justify-center items-center font-bold text-lg">${(currentUser.displayName||'U').substring(0,1).toUpperCase()}</div>`}
                        <div class="overflow-hidden">
                            <p class="text-white font-bold truncate flex items-center">${currentUser.displayName || 'Usuário'} ${verifiedIcon}</p>
                            <p class="text-spotify-text text-xs truncate">${currentUser.email}</p>
                        </div>
                    </div>
                    <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="copyMyProfileLink()">
                        <i class="ph-bold ph-share-network text-lg"></i> Compartilhar Perfil
                    </button>
                    <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="openSettingsModal()">
                        <i class="ph-bold ph-gear text-lg"></i> Configurações
                    </button>
                    <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="openShortcutsModal(); toggleProfileMenu()">
                        <i class="ph-bold ph-keyboard text-lg"></i> Atalhos de Teclado
                    </button>
                    <a href="inicio.html" target="_blank" rel="noopener" class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none">
                        <i class="ph-bold ph-question text-lg"></i> Sobre o Exlify
                    </a>
                    <div class="h-[1px] bg-white/10 my-1 mx-2"></div>
                    <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none text-red-400" onclick="handleLogout(); toggleProfileMenu()">
                        <i class="ph-bold ph-sign-out text-lg"></i> Sair
                    </button>
                `;
            } else {
                menu.innerHTML = `
                    <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none font-bold text-white" onclick="openAuthModal(); toggleProfileMenu()">
                        <i class="ph-bold ph-sign-in text-lg"></i> Fazer Login
                    </button>
                    <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="openSettingsModal()">
                        <i class="ph-bold ph-gear text-lg"></i> Configurações
                    </button>
                    <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="openShortcutsModal(); toggleProfileMenu()">
                        <i class="ph-bold ph-keyboard text-lg"></i> Atalhos de Teclado
                    </button>
                    <a href="inicio.html" target="_blank" rel="noopener" class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none">
                        <i class="ph-bold ph-question text-lg"></i> Sobre o Exlify
                    </a>
                `;
            }
            
            document.addEventListener('click', closeProfileMenuOutside);
        } else {
            menu.classList.add('hidden');
            document.removeEventListener('click', closeProfileMenuOutside);
        }
    }

    function closeProfileMenuOutside(e) {
        if (!document.getElementById('profileDropdownMenu').contains(e.target) && !document.getElementById('userProfileBtnHeader').contains(e.target)) {
            isProfileMenuOpen = false;
            document.getElementById('profileDropdownMenu').classList.add('hidden');
            document.removeEventListener('click', closeProfileMenuOutside);
        }
    }

    function openSettingsModal() {
        if(isProfileMenuOpen) toggleProfileMenu();
        document.body.classList.add('modal-open');
        const modal = document.getElementById('settingsModal');

        const reduceMotionCb = document.getElementById('settingReduceMotion');
        if (reduceMotionCb) reduceMotionCb.checked = !!appState.settings.reduceMotion;
        const dataSaverCb = document.getElementById('settingDataSaver');
        if (dataSaverCb) dataSaverCb.checked = !!appState.settings.dataSaver;
        
        const authSec = document.getElementById('authSettingsSection');
        const noAuthSec = document.getElementById('notAuthSettingsSection');
        
        if(currentUser) {
            authSec.classList.remove('hidden');
            authSec.classList.add('flex');
            noAuthSec.classList.add('hidden');
            document.getElementById('settingsNameInput').value = currentUser.displayName || '';
            if(appState.profileImage) document.getElementById('settingsProfilePreview').src = appState.profileImage;
        } else {
            authSec.classList.add('hidden');
            authSec.classList.remove('flex');
            noAuthSec.classList.remove('hidden');
        }

        modal.classList.remove('hidden');
        setTimeout(() => {
            modal.classList.remove('opacity-0');
            document.getElementById('settingsContent').classList.remove('scale-95');
        }, 10);
    }

    function closeSettingsModal() {
        document.body.classList.remove('modal-open');
        const modal = document.getElementById('settingsModal');
        modal.classList.add('opacity-0');
        document.getElementById('settingsContent').classList.add('scale-95');
        setTimeout(() => modal.classList.add('hidden'), 200);
    }
    
    let pendingProfileImageFile = null;
    function previewProfileImage(e) {
        const file = e.target.files[0];
        if(file) {
            pendingProfileImageFile = file;
            const reader = new FileReader();
            reader.onload = (ev) => { document.getElementById('settingsProfilePreview').src = ev.target.result; };
            reader.readAsDataURL(file);
        }
    }

    async function handleUpdateProfile() {
        const newName = document.getElementById('settingsNameInput').value.trim();
        if(!newName || !currentUser) return;
        
        const btn = document.getElementById('settingsSaveBtn');
        btn.innerText = "Salvando...";
        btn.disabled = true;

        try {
            if(pendingProfileImageFile) {
                const url = await uploadToImgBB(pendingProfileImageFile);
                if(url) appState.profileImage = url;
            }

            await currentUser.updateProfile({ displayName: newName });
            showToast("Perfil atualizado com sucesso!");
            saveData(); 
            updateProfileHeaderUI();
            closeSettingsModal();
        } catch(e) { showToast("Erro ao atualizar: " + e.message); }
        
        btn.innerText = "Salvar Perfil";
        btn.disabled = false;
        pendingProfileImageFile = null;
    }

    function copyMyProfileLink() {
        toggleProfileMenu();
        if(!currentUser) return;
        const url = window.location.href.split('?')[0] + "?user=" + currentUser.uid;
        navigator.clipboard.writeText(url).then(() => showToast("Link do perfil copiado!"));
    }

    async function handlePasswordReset() {
        if(!currentUser || !currentUser.email) return;
        try {
            await auth.sendPasswordResetEmail(currentUser.email);
            showToast("E-mail de recuperação enviado para " + currentUser.email);
            closeSettingsModal();
        } catch(e) { showToast("Erro: " + e.message); }
    }

    // --- AUTH LISTENERS E FUNÇÕES DA NUVEM ---
    auth.onAuthStateChanged(async (user) => {
        currentUser = user;
        const btnHeader = document.getElementById('userProfileBtnHeader');
        
        if(user) {
            btnHeader.classList.remove('bg-spotify-elevated', 'text-white'); 
            btnHeader.classList.add('bg-[#1ed760]', 'text-black');
            const banner = document.getElementById('loginBanner');
            if(banner) banner.style.display = 'none';
        } else {
            btnHeader.classList.add('bg-spotify-elevated', 'text-white'); 
            btnHeader.classList.remove('bg-[#1ed760]', 'text-black');
            const banner = document.getElementById('loginBanner');
            if(banner && currentView === 'home') banner.style.display = 'flex';
        }
        updateMobileNavbar();
        await loadData();
    });

    function updateMobileNavbar() {
        const nav = document.getElementById('mobileNavBar');
        if(!nav) return;
        
        if(currentUser) {
            nav.innerHTML = `
                <button id="nav-home" class="mobile-nav-btn flex flex-col items-center gap-1 text-white opacity-100 focus:outline-none transition-colors w-1/3" onclick="navigateTo('home')">
                    <i class="ph-fill ph-house text-2xl"></i><span class="text-[10px] font-medium mt-[-2px]">Início</span>
                </button>
                <button id="nav-search" class="mobile-nav-btn flex flex-col items-center gap-1 text-spotify-text hover:text-white transition-colors focus:outline-none w-1/3" onclick="navigateTo('search')">
                    <i class="ph-bold ph-magnifying-glass text-2xl"></i><span class="text-[10px] font-medium mt-[-2px]">Buscar</span>
                </button>
                <button id="nav-library" class="mobile-nav-btn flex flex-col items-center gap-1 text-spotify-text hover:text-white transition-colors focus:outline-none w-1/3" onclick="navigateTo('library')">
                    <i class="ph-bold ph-books text-2xl"></i><span class="text-[10px] font-medium mt-[-2px]">Biblioteca</span>
                </button>
            `;
        } else {
            nav.innerHTML = `
                <button id="nav-home" class="mobile-nav-btn flex flex-col items-center gap-1 text-white opacity-100 focus:outline-none transition-colors w-1/4" onclick="navigateTo('home')">
                    <i class="ph-fill ph-house text-xl"></i><span class="text-[10px] font-medium mt-[-2px]">Início</span>
                </button>
                <button id="nav-search" class="mobile-nav-btn flex flex-col items-center gap-1 text-spotify-text hover:text-white transition-colors focus:outline-none w-1/4" onclick="navigateTo('search')">
                    <i class="ph-bold ph-magnifying-glass text-xl"></i><span class="text-[10px] font-medium mt-[-2px]">Buscar</span>
                </button>
                <button id="nav-library" class="mobile-nav-btn flex flex-col items-center gap-1 text-spotify-text hover:text-white transition-colors focus:outline-none w-1/4" onclick="navigateTo('library')">
                    <i class="ph-bold ph-books text-xl"></i><span class="text-[10px] font-medium mt-[-2px]">Biblioteca</span>
                </button>
                <button class="mobile-nav-btn flex flex-col items-center gap-1 text-spotify-text hover:text-white transition-colors focus:outline-none w-1/4" onclick="openAuthModal()">
                    <i class="ph-bold ph-sign-in text-xl"></i><span class="text-[10px] font-medium mt-[-2px]">Fazer Login</span>
                </button>
            `;
        }
        document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
            btn.classList.remove('text-white', 'opacity-100');
            btn.classList.add('text-spotify-text');
        });
        const activeBtn = document.getElementById('nav-' + currentView);
        if(activeBtn) {
            activeBtn.classList.add('text-white', 'opacity-100');
            activeBtn.classList.remove('text-spotify-text');
        }
    }

    function checkAuth(actionDescription) {
        if (!currentUser) {
            showToast(`Faça login para ${actionDescription}.`);
            openAuthModal();
            return false;
        }
        return true;
    }

    function toggleAuthForms(show) {
        const login = document.getElementById('authLoginSection');
        const reg = document.getElementById('authRegisterSection');
        if(show === 'register') { login.classList.add('hidden'); reg.classList.remove('hidden'); } 
        else { reg.classList.add('hidden'); login.classList.remove('hidden'); }
    }

    function openAuthModal() {
        document.body.classList.add('modal-open');
        const modal = document.getElementById('authModal');
        document.getElementById('authLoginSection').classList.remove('hidden');
        document.getElementById('authRegisterSection').classList.add('hidden');
        
        modal.classList.remove('hidden');
        setTimeout(() => {
            modal.classList.remove('opacity-0');
            document.getElementById('authContent').classList.remove('scale-95');
        }, 10);
    }

    function closeAuthModal() {
        document.body.classList.remove('modal-open');
        document.getElementById('authModal').classList.add('opacity-0');
        document.getElementById('authContent').classList.add('scale-95');
        setTimeout(() => document.getElementById('authModal').classList.add('hidden'), 200);
    }

    async function handleGoogleLogin() {
        try {
            const provider = new firebase.auth.GoogleAuthProvider();
            await auth.signInWithPopup(provider);
            closeAuthModal();
            showToast("Sessão iniciada na Nuvem");
        } catch(e) { showToast("Erro: " + e.message); }
    }

    async function handleEmailAuth(type) {
        const email = document.getElementById('authEmail').value.trim();
        const pass = document.getElementById('authPassword').value;
        if(!email || !pass) return showToast("Preencha email e senha.");
        
        try {
            await auth.signInWithEmailAndPassword(email, pass);
            closeAuthModal();
            showToast("Sessão iniciada na Nuvem");
        } catch(e) { showToast("Usuário ou senha incorretos."); }
    }

    async function handleEmailRegister() {
        const name = document.getElementById('regName').value.trim();
        const email = document.getElementById('regEmail').value.trim();
        const pass = document.getElementById('regPassword').value;
        const pass2 = document.getElementById('regPassword2').value;

        if(!name || !email || !pass) return showToast("Preencha todos os campos.");
        if(pass !== pass2) return showToast("As senhas não coincidem.");
        if(pass.length < 6) return showToast("Senha deve ter ao menos 6 caracteres.");

        try {
            const userCredential = await auth.createUserWithEmailAndPassword(email, pass);
            await userCredential.user.updateProfile({ displayName: name });
            closeAuthModal();
            showToast("Conta criada e sessão iniciada na Nuvem!");
        } catch(e) { showToast("Erro: " + e.message); }
    }

    function handleLogout() {
        auth.signOut();
        showToast("Você saiu da sua conta.");
        appState.playlists = [{ id: 'liked', name: 'Músicas Curtidas', type: 'system', cover: 'https://misc.scdn.co/liked-songs/liked-songs-640.png', tracks: [] }];
        appState.likedSongs = [];
        appState.followedArtists = [];
        appState.profileImage = null;
        appState.verified = false;
        saveData();
        setTimeout(() => window.location.reload(), 500);
    }

    // --- PLAYER STATE E DOM ELEMENTOS ---
    const playerState = {
        isPlaying: false, duration: 0, volume: 1, isMuted: false, isShuffle: false, isRepeat: false, isCasting: false, isLoading: false
    };

    const dom = {
        audio: document.getElementById('audioPlayer'),
        btnPlayPause: document.getElementById('btnPlayPause'),
        iconPlayPause: document.getElementById('iconPlayPause'),
        mobileIconPlay: document.getElementById('mobileIconPlay'),
        fsIconPlayPause: document.getElementById('fsIconPlayPause'),
        dsBtnPlayPause: document.getElementById('dsBtnPlayPause'),
        dsIconPlayPause: document.getElementById('dsIconPlayPause'), 
        progressSlider: document.getElementById('progressSlider'),
        progressContainer: document.getElementById('progressContainer'),
        mobileProgressFill: document.getElementById('mobileProgressFill'),
        fsProgressSlider: document.getElementById('fsProgressSlider'),
        fsProgressContainer: document.getElementById('fsProgressContainer'),
        timeCurrent: document.getElementById('timeCurrent'),
        timeTotal: document.getElementById('timeTotal'),
        fsTimeCurrent: document.getElementById('fsTimeCurrent'),
        fsTimeTotal: document.getElementById('fsTimeTotal'),
        volumeSlider: document.getElementById('volumeSlider'),
        volumeContainer: document.getElementById('volumeContainer'),
        volIcon: document.getElementById('volIcon'),
        playingTitle: document.getElementById('playingTitle'),
        playingArtist: document.getElementById('playingArtist'),
        playerThumb: document.getElementById('playerThumb'),
        mobileTitle: document.getElementById('mobileTitle'),
        mobileArtist: document.getElementById('mobileArtist'),
        mobileThumb: document.getElementById('mobileThumb'),
        fsTitle: document.getElementById('fsTitle'),
        fsArtist: document.getElementById('fsArtist'),
        fsThumb: document.getElementById('fsThumb'),
        fsContextName: document.getElementById('fsContextName'),
        playerLikeIcon: document.getElementById('playerLikeIcon'),
        fsLikeIcon: document.getElementById('fsLikeIcon'),
        loadingOverlays: document.querySelectorAll('.loading-thumb-overlay'),
        viewContainer: document.getElementById('viewContainer'),
        headerGradient: document.getElementById('headerGradient'),
        mainHeader: document.getElementById('mainHeader'),
        searchContainer: document.getElementById('searchContainer'),
        mobileFullscreenPlayer: document.getElementById('mobileFullscreenPlayer'),
        desktopScreensaver: document.getElementById('desktopScreensaver') 
    };

    let currentView = 'home';
    let sleepTimerRef = null;
    let isProgressHovered = false;
    
    let deferredPrompt;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        const banner = document.getElementById('installAppBanner');
        if(banner && currentView === 'home') banner.style.display = 'flex';
    });

    function installPWA() {
        if(deferredPrompt) {
            deferredPrompt.prompt();
            deferredPrompt.userChoice.then((choiceResult) => {
                if (choiceResult.outcome === 'accepted') {
                    const banner = document.getElementById('installAppBanner');
                    if(banner) banner.style.display = 'none';
                }
                deferredPrompt = null;
            });
        } else {
            showToast("No iPhone/Safari: Toque em 'Compartilhar' e 'Adicionar à Tela de Início'.");
        }
    }
    
    function handleIOSCast(e) {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        if(isIOS && (!window.chrome || !window.chrome.cast)) {
            e.preventDefault();
            showToast("No iPhone, o Google Cast funciona melhor pelo app Google Chrome.");
        }
    }

    // SWIPE SYSTEM NO PLAYER MOBILE
    let touchStartX = 0;
    let touchEndX = 0;
    const fsArtContainer = document.getElementById('fsArtContainer');

    fsArtContainer.addEventListener('touchstart', e => {
        touchStartX = e.changedTouches[0].screenX;
        fsArtContainer.style.transition = 'none';
    });

    fsArtContainer.addEventListener('touchmove', e => {
        const currentX = e.changedTouches[0].screenX;
        const diff = currentX - touchStartX;
        if (Math.abs(diff) < window.innerWidth) {
            fsArtContainer.style.transform = `translateX(${diff * 0.5}px)`;
        }
    });

    fsArtContainer.addEventListener('touchend', e => {
        touchEndX = e.changedTouches[0].screenX;
        fsArtContainer.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
        fsArtContainer.style.transform = 'translateX(0px)';
        if (touchStartX - touchEndX > 70) playNext();
        else if (touchEndX - touchStartX > 70) playPrev();
    });

    function handleArtistClickFromPlayer() {
        if(appState.currentTrackIndex > -1){ 
            closeFullscreenPlayer(); 
            closeDesktopScreensaver();
            setTimeout(() => {
                openArtistPlaylist(appState.queue[appState.currentTrackIndex].artist);
            }, 300);
        }
    }

    window.searchStyle = function(style) {
        navigateTo('search');
        setTimeout(() => {
            const inputD = document.getElementById('queryInput');
            const inputM = document.getElementById('mobileQueryInput');
            if(inputD) inputD.value = style;
            if(inputM) inputM.value = style;
            performSearch(style);
        }, 50);
    }

    // --- NAVEGAÇÃO ---
    function navigateTo(view, data = null) {
        const scrollArea = document.getElementById('mainScrollArea');
        if(currentView) {
            if(currentView === 'playlist' && appState.history[appState.historyIndex]?.data) {
                viewScrollStates.playlist[appState.history[appState.historyIndex].data] = scrollArea.scrollTop;
            } else viewScrollStates[currentView] = scrollArea.scrollTop;
        }

        let isReset = false;
        if (currentView === view && appState.history[appState.historyIndex]?.data === data) {
            isReset = true;
            if(view === 'playlist') viewScrollStates.playlist[data] = 0;
            else viewScrollStates[view] = 0;
            scrollArea.scrollTo({ top: 0, behavior: 'smooth' });
            if(view === 'search') clearDesktopSearch();
            return; 
        }

        currentView = view;
        appState.displayLimit = 12; 
        
        if (appState.history[appState.historyIndex]?.view !== view || appState.history[appState.historyIndex]?.data !== data) {
            appState.history = appState.history.slice(0, appState.historyIndex + 1);
            appState.history.push({view, data});
            appState.historyIndex++;
        }

        const mobileSearchHeader = document.getElementById('mobileSearchHeader');
        if (view === 'search' && window.innerWidth < 768) mobileSearchHeader.style.display = 'block';
        else mobileSearchHeader.style.display = 'none';
        
        updateMobileNavbar();
        appState.currentFilter = 'all'; 
        
        if (view === 'home') renderHome();
        else if (view === 'search') {
            if(document.getElementById('queryInput').value === '') renderSearchDefault();
            else performSearch(document.getElementById('queryInput').value); 
        }
        else if (view === 'playlist') renderPlaylist(data);
        else if (view === 'library') renderLibraryMobile();
        else if (view === 'profile') renderUserProfile(data); // Rota Profile Corrigida

        setTimeout(() => {
            if (view === 'playlist') scrollArea.scrollTop = viewScrollStates.playlist[data] || 0;
            else scrollArea.scrollTop = viewScrollStates[view] || 0;
        }, 50);
    }

    function goBack() {
        if (appState.historyIndex > 0) {
            appState.historyIndex--;
            const state = appState.history[appState.historyIndex];
            navigateTo(state.view, state.data);
            appState.historyIndex--; 
        }
    }
    function goForward() {
        if (appState.historyIndex < appState.history.length - 1) {
            appState.historyIndex++;
            const state = appState.history[appState.historyIndex];
            navigateTo(state.view, state.data);
            appState.historyIndex--;
        }
    }

    function setHeaderColor(color) {
        dom.headerGradient.style.backgroundImage = `linear-gradient(to bottom, ${color}, transparent)`;
        dom.mobileFullscreenPlayer.style.backgroundImage = `linear-gradient(to bottom, ${color}, #121212)`;
    }

    function getGreeting() {
        const hour = new Date().getHours();
        if(hour < 12) return 'Bom dia';
        if(hour < 18) return 'Boa tarde';
        return 'Boa noite';
    }

    // --- FILTRAGEM ---
    function setFilter(filterType) {
        appState.currentFilter = filterType;
        
        document.querySelectorAll('#viewContainer .filter-chip').forEach(chip => {
            if (chip.dataset.filter === filterType) {
                chip.classList.replace('bg-[#242424]', 'bg-white');
                chip.classList.replace('text-white', 'text-black');
                chip.classList.remove('hover:bg-[#2a2a2a]');
            } else {
                chip.classList.replace('bg-white', 'bg-[#242424]');
                chip.classList.replace('text-black', 'text-white');
                chip.classList.add('hover:bg-[#2a2a2a]');
            }
        });

        document.querySelectorAll('#viewContainer .filterable-item').forEach(el => {
            if (filterType === 'all') el.style.display = '';
            else el.style.display = el.dataset.type === filterType ? '' : 'none';
        });
        
        document.querySelectorAll('#viewContainer .filterable-section').forEach(sec => {
            const hasVisibleItems = Array.from(sec.querySelectorAll('.filterable-item')).some(el => el.style.display !== 'none');
            sec.style.display = hasVisibleItems ? '' : 'none';
        });
        
        if(filterType === 'users' && document.getElementById('queryInput').value.length > 2) {
            performUserSearch(document.getElementById('queryInput').value);
        }
    }
    
    function filterSidebar(filterType) {
        document.querySelectorAll('#sidebarLibrary .filterable-item').forEach(el => {
            if (filterType === 'all') el.style.display = '';
            else el.style.display = el.dataset.type === filterType ? '' : 'none';
        });
    }

    function loadMoreContent() {
        appState.displayLimit += 12;
        if (currentView === 'search') {
            renderSearchResults(appState.lastSearchResult || [], document.getElementById('queryInput').value, false);
        } else if (currentView === 'playlist' || currentView.startsWith('artist_')) {
            const state = appState.history[appState.historyIndex];
            if(state.view === 'playlist') renderPlaylist(state.data);
        }
    }

    // --- VIEWS RENDER ---
    function renderHome() {
        setHeaderColor('#333333');
        
        let topCardsHtml = '';
        const topItems = appState.playlists.slice(0, 6);
        if(topItems.length < 6) {
            topItems.push({name: 'Daily Mix 1', cover: '1.png', type: 'mock'});
            topItems.push({name: 'Daily Mix 2', cover: '2.png', type: 'mock'});
            topItems.push({name: 'Novidades', cover: '3.png', type: 'mock'});
        }

        topItems.forEach(item => {
            const isReal = item.id !== undefined;
            const clickAction = isReal ? `MapsTo('playlist', '${item.id}')` : `searchStyle('Tudo')`; // Fix the clickAction
            topCardsHtml += `
                <div class="bg-white/10 hover:bg-white/20 transition flex items-center rounded overflow-hidden cursor-pointer group h-[60px] sm:h-20" onclick="${clickAction}">
                    <img src="${item.cover || DEFAULT_COVER}" loading="lazy" decoding="async" class="w-[60px] sm:w-20 h-full object-cover shadow-[0_0_10px_rgba(0,0,0,0.5)] shrink-0">
                    <div class="flex-1 px-4 font-bold text-white text-[14px] sm:text-[15px] line-clamp-2">${item.name}</div>
                    <button class="w-12 h-12 rounded-full bg-[#1ed760] text-black flex items-center justify-center mr-4 opacity-0 group-hover:opacity-100 transition hover:scale-105 shadow-xl focus:outline-none shrink-0" onclick="event.stopPropagation(); playContext('${item.id || 'mock'}')">
                        <i class="ph-fill ph-play text-[22px] translate-x-[1px]"></i>
                    </button>
                </div>`;
        });

        let trendingHtml = '';
        if (!isTrendingLoaded) {
            trendingHtml = Array(5).fill(`
                <div class="flex items-center gap-4 px-4 py-2 animate-pulse w-full">
                    <div class="w-12 h-12 bg-[#282828] rounded"></div>
                    <div class="flex-1 space-y-2 py-1">
                        <div class="h-4 bg-[#282828] rounded w-3/4"></div>
                        <div class="h-3 bg-[#282828] rounded w-1/2"></div>
                    </div>
                </div>`).join('');
        } else {
            topTrendingData.forEach((track, index) => {
                trendingHtml += generateTrackRow(track, index, 'trending');
            });
            appState.queueContext = 'trending'; 
            appState.queue = [...topTrendingData]; 
        }

        let recentlyPlayedHtml = '';
        if (appState.recentlyPlayed && appState.recentlyPlayed.length > 0) {
            const cards = appState.recentlyPlayed.slice(0, 10).map((t, i) => `
                <div class="bg-[#181818] hover:bg-[#282828] p-3 rounded-lg transition cursor-pointer group shrink-0 w-[140px] sm:w-auto card-hover-lift" onclick="playFromRecentlyPlayed(${i})">
                    <div class="relative w-full aspect-square mb-3">
                        <img src="${t.cover || DEFAULT_COVER}" loading="lazy" decoding="async" class="w-full h-full object-cover rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.5)]" onerror="this.src='${DEFAULT_COVER}'">
                        <button class="absolute bottom-2 right-2 w-10 h-10 rounded-full bg-[#1ed760] text-black flex items-center justify-center opacity-0 group-hover:opacity-100 transition hover:scale-105 shadow-xl focus:outline-none z-10">
                            <i class="ph-fill ph-play text-lg translate-x-[1px]"></i>
                        </button>
                    </div>
                    <h3 class="text-white font-bold mb-0.5 truncate text-[14px]">${t.title}</h3>
                    <p class="text-[13px] text-spotify-text truncate">${t.artist}</p>
                </div>
            `).join('');
            recentlyPlayedHtml = `
                <div class="flex items-baseline justify-between mb-4 mt-2">
                    <h2 class="text-white text-[22px] font-bold tracking-tight">Tocadas recentemente</h2>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6 pb-4 mb-4">
                    ${cards}
                </div>
            `;
        }

        let recentRecommendationsHtml = '';
        if (appState.recentSearches && appState.recentSearches.length > 0) {
            const lastSearch = appState.recentSearches[0];
            recentRecommendationsHtml = `
                <div class="flex items-baseline justify-between mb-4 mt-8">
                    <h2 class="text-white text-[22px] font-bold hover:underline cursor-pointer tracking-tight">Porque você buscou por "${lastSearch}"</h2>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6 overflow-x-auto pb-4 custom-scrollbar">
                    ${generateSquareCard(lastSearch + ' Mix', 'O melhor do seu estilo.', 'https://placehold.co/150x150/1ed760/000?text=Mix')}
                    ${generateSquareCard('Top ' + lastSearch, 'Mais tocadas.', 'https://placehold.co/150x150/8a2be2/fff?text=Top')}
                    ${generateSquareCard(lastSearch + ' Classics', 'Clássicos atemporais.', 'https://placehold.co/150x150/ff4500/fff?text=Classics')}
                    ${generateSquareCard(lastSearch + ' Acústico', 'Versões relaxantes.', 'https://placehold.co/150x150/4682b4/fff?text=Acústico')}
                </div>
            `;
        }

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

                <div class="flex items-center gap-2 mb-6 overflow-x-auto custom-scrollbar pb-2 hide-scrollbar-mobile w-full">
                    <button class="bg-white/10 hover:bg-white/20 text-white px-4 py-1.5 rounded-full text-[14px] font-medium transition focus:outline-none shrink-0 flex items-center gap-2" onclick="searchStyle('Podcasts')"><i class="ph-bold ph-microphone-stage text-lg"></i> Podcasts</button>
                    <button class="bg-white/10 hover:bg-white/20 text-white px-4 py-1.5 rounded-full text-[14px] font-medium transition focus:outline-none shrink-0 flex items-center gap-2" onclick="searchStyle('Sertanejo')"><i class="ph-bold ph-guitar text-lg"></i> Sertanejo</button>
                    <button class="bg-white/10 hover:bg-white/20 text-white px-4 py-1.5 rounded-full text-[14px] font-medium transition focus:outline-none shrink-0 flex items-center gap-2" onclick="searchStyle('Pop')"><i class="ph-bold ph-star text-lg"></i> Pop</button>
                    <button class="bg-white/10 hover:bg-white/20 text-white px-4 py-1.5 rounded-full text-[14px] font-medium transition focus:outline-none shrink-0 flex items-center gap-2" onclick="searchStyle('Relax')"><i class="ph-bold ph-coffee text-lg"></i> Relax</button>
                    <button class="bg-white/10 hover:bg-white/20 text-white px-4 py-1.5 rounded-full text-[14px] font-medium transition focus:outline-none shrink-0 flex items-center gap-2" onclick="searchStyle('Treino')"><i class="ph-bold ph-barbell text-lg"></i> Treino</button>
                </div>

                <h2 class="text-white text-2xl sm:text-3xl font-bold mb-4 tracking-tight">${getGreeting()}${currentUser ? ', ' + (currentUser.displayName||'').split(' ')[0] : ''}</h2>
                <div class="grid grid-cols-2 xl:grid-cols-3 gap-2 sm:gap-3 mb-10">
                    ${topCardsHtml}
                </div>

                ${recentlyPlayedHtml}

                <div class="flex items-baseline justify-between mb-4">
                    <h2 class="text-white text-[22px] font-bold hover:underline cursor-pointer tracking-tight">No momento as mais ouvidas (YouTube)</h2>
                </div>
                <div class="flex flex-col mb-10 bg-black/20 rounded-lg p-2">
                    ${trendingHtml}
                </div>
                
                <div class="flex items-baseline justify-between mb-4">
                    <h2 class="text-white text-[22px] font-bold hover:underline cursor-pointer tracking-tight">Feito para você</h2>
                    <span class="text-spotify-text text-[13px] font-bold hover:underline cursor-pointer">Mostrar tudo</span>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6 overflow-x-auto pb-4 custom-scrollbar">
                    ${generateSquareCard('Descobertas', 'Novas músicas selecionadas.', 'https://musicopolis.com.br/wp-content/uploads/2025/05/Tubaroes-de-Diego-e-Victor-Hugo-e-a-musica-sertaneja-mais-tocada-de-abril.webp')}
                    ${generateSquareCard('Radar de Novidades', 'Lançamentos da semana.', 'https://image-cdn-fa.spotifycdn.com/image/ab67706c0000da8481e3d7525172caf199acce11')}
                    ${generateSquareCard('Top Brasil', 'As mais tocadas no momento.', 'https://i.scdn.co/image/ab67616d0000b2739f2f923c01834c4b1c1084ec')}
                    ${generateSquareCard('Lofi Beats', 'Batidas relaxantes.', 'https://i.ytimg.com/vi/5qap5aO4i9A/maxresdefault.jpg')}
                </div>

                ${recentRecommendationsHtml}
            </div>
        `;
        setTimeout(updateActiveTrackUI, 50); 
    }

    function generateSquareCard(title, desc, img) {
        return `
            <div class="bg-[#181818] hover:bg-[#282828] p-4 rounded-lg transition cursor-pointer group shrink-0 w-[140px] sm:w-auto" onclick="searchStyle('${title.split(' ')[0]}')">
                <div class="relative w-full aspect-square mb-4">
                    <img src="${img}" loading="lazy" decoding="async" class="w-full h-full object-cover rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
                    <button class="absolute bottom-2 right-2 w-12 h-12 rounded-full bg-[#1ed760] text-black flex items-center justify-center opacity-0 group-hover:opacity-100 transition hover:scale-105 hover:-translate-y-1 shadow-xl translate-y-1 focus:outline-none z-10">
                        <i class="ph-fill ph-play text-[22px] translate-x-[1px]"></i>
                    </button>
                </div>
                <h3 class="text-white font-bold mb-1 truncate text-[15px] pb-0.5">${title}</h3>
                <p class="text-[14px] text-spotify-text line-clamp-2 leading-tight">${desc}</p>
            </div>
        `;
    }

    function renderLibraryMobile() {
        setHeaderColor('#121212');
        
        let playlistHtml = '';
        appState.playlists.forEach(pl => {
            const count = pl.tracks ? pl.tracks.length : 0;
            let subType = 'Playlist • Exlify';
            if (pl.type === 'system') subType = 'Playlist';
            if (pl.type === 'youtube') subType = `YouTube • ${pl.owner || 'Original'}`;
            if (pl.type === 'shared') subType = `Compartilhada • ${pl.ownerName || 'Amigo'}`;

            playlistHtml += `
                <div class="flex items-center gap-4 p-2 hover:bg-white/10 rounded-md cursor-pointer transition group w-full filterable-item relative" data-type="playlists" onclick="navigateTo('playlist', '${pl.id}')" oncontextmenu="openPlaylistContextMenu(event, '${pl.id}')">
                    <img src="${pl.cover || DEFAULT_COVER}" loading="lazy" decoding="async" class="w-16 h-16 rounded object-cover shadow-md shrink-0">
                    <div class="flex-1 overflow-hidden min-w-0">
                        <p class="text-white font-medium text-[16px] text-truncate-safe">${pl.name} ${pl.isPublic ? '<i class="ph-bold ph-globe text-spotify-text text-[12px] ml-1"></i>' : ''}</p>
                        <p class="text-[13px] text-spotify-text text-truncate-safe">${subType} • ${count} músicas</p>
                    </div>
                    <button class="text-spotify-text hover:text-white focus:outline-none p-2 shrink-0" onclick="event.stopPropagation(); openPlaylistContextMenu(event, '${pl.id}')" title="Mais opções">
                        <i class="ph-bold ph-dots-three text-xl"></i>
                    </button>
                </div>`;
        });

        let artistHtml = '';
        if (appState.followedArtists.length > 0) {
            appState.followedArtists.forEach(art => {
                const safeArtist = art.replace(/'/g, "\\'");
                artistHtml += `
                    <div class="flex items-center gap-4 p-2 hover:bg-white/10 rounded-md cursor-pointer transition group w-full filterable-item relative" data-type="artists" onclick="openArtistPlaylist('${safeArtist}')" oncontextmenu="openArtistContextMenu(event, '${safeArtist}')">
                        <div class="w-16 h-16 rounded-full bg-[#333] flex items-center justify-center text-xl text-white shadow-md overflow-hidden shrink-0">
                            <img src="https://placehold.co/100x100/282828/fff?text=${art.substring(0,2)}" class="w-full h-full object-cover">
                        </div>
                        <div class="flex-1 overflow-hidden min-w-0 pr-8">
                            <p class="text-white font-medium text-[16px] text-truncate-safe">${art}</p>
                            <p class="text-[13px] text-spotify-text text-truncate-safe">Artista</p>
                        </div>
                        <button class="absolute right-4 text-spotify-text hover:text-red-400 focus:outline-none p-2 md:opacity-0 group-hover:opacity-100 transition" onclick="event.stopPropagation(); toggleFollowArtist('${safeArtist}')">
                            <i class="ph-bold ph-user-minus text-xl"></i>
                        </button>
                    </div>`;
            });
        }
        
        dom.viewContainer.innerHTML = `
            <div class="flex items-center justify-between mb-6 pt-2 fade-in w-full max-w-[1500px] mx-auto">
                <h2 class="text-white text-2xl font-bold truncate tracking-tight">Sua Biblioteca</h2>
                <div class="flex gap-4 items-center shrink-0">
                    <button class="text-spotify-text hover:text-white transition focus:outline-none tooltip" title="Importar via Link ou CSV" onclick="openImportModal()"><i class="ph-bold ph-link text-2xl"></i></button>
                    <button class="text-spotify-text hover:text-white transition focus:outline-none" onclick="navigateTo('search')"><i class="ph-bold ph-magnifying-glass text-2xl"></i></button>
                    <button class="text-spotify-text hover:text-white transition focus:outline-none" onclick="openCreatePlaylistModal()">
                        <i class="ph-bold ph-plus text-2xl"></i>
                    </button>
                </div>
            </div>
            <div class="flex gap-2 mb-4 overflow-x-auto pb-2 custom-scrollbar fade-in w-full max-w-[1500px] mx-auto">
                <button class="filter-chip bg-white text-black px-4 py-1.5 rounded-full text-[13px] font-medium shrink-0" data-filter="all" onclick="setFilter('all')">Tudo</button>
                <button class="filter-chip bg-[#242424] hover:bg-[#2a2a2a] text-white px-4 py-1.5 rounded-full text-[13px] font-medium shrink-0 transition" data-filter="playlists" onclick="setFilter('playlists')">Playlists</button>
                <button class="filter-chip bg-[#242424] hover:bg-[#2a2a2a] text-white px-4 py-1.5 rounded-full text-[13px] font-medium shrink-0 transition" data-filter="artists" onclick="setFilter('artists')">Artistas</button>
            </div>
            
            <div class="flex flex-col pb-6 mt-2 fade-in w-full max-w-[1500px] mx-auto filterable-section">
                ${playlistHtml}
            </div>
            
            <div class="flex flex-col pb-24 fade-in w-full max-w-[1500px] mx-auto filterable-section">
                ${artistHtml.length > 0 ? `<h3 class="text-white font-bold mb-3 px-2 filterable-item" data-type="artists">Artistas que você segue</h3>${artistHtml}` : ''}
            </div>
        `;
        
        setFilter(appState.currentFilter);
    }

    function renderSidebar() {
        const container = document.getElementById('sidebarLibrary');
        if(!container) return;
        container.innerHTML = '';
        
        appState.playlists.forEach(pl => {
            const count = pl.tracks ? pl.tracks.length : 0;
            container.innerHTML += `
                <div class="flex items-center gap-3 p-2 hover:bg-[#1a1a1a] rounded-md cursor-pointer transition group filterable-item" data-type="playlists" onclick="navigateTo('playlist', '${pl.id}')" oncontextmenu="openPlaylistContextMenu(event, '${pl.id}')">
                    <img src="${pl.cover || DEFAULT_COVER}" loading="lazy" decoding="async" class="w-12 h-12 rounded shadow object-cover shrink-0">
                    <div class="overflow-hidden min-w-0 flex-1">
                        <p class="text-white font-medium text-[15px] truncate">${pl.name}</p>
                        <p class="text-[13px] text-spotify-text truncate">${pl.type === 'system' ? 'Playlist' : 'Playlist'} • ${count} músicas</p>
                    </div>
                    <button class="text-spotify-text hover:text-white focus:outline-none p-1.5 opacity-0 group-hover:opacity-100 transition shrink-0" onclick="event.stopPropagation(); openPlaylistContextMenu(event, '${pl.id}')" title="Mais opções">
                        <i class="ph-bold ph-dots-three text-lg"></i>
                    </button>
                </div>`;
        });

        if (appState.followedArtists.length > 0) {
            container.innerHTML += `<div class="mt-4 mb-2 px-2 text-[11px] font-bold uppercase tracking-wider text-spotify-text filterable-item" data-type="artists">Artistas</div>`;
            appState.followedArtists.forEach(art => {
                const safeArt = art.replace(/'/g, "\\'");
                container.innerHTML += `
                    <div class="flex items-center gap-3 p-2 hover:bg-[#1a1a1a] rounded-md cursor-pointer transition group filterable-item" data-type="artists" onclick="openArtistPlaylist('${safeArt}')" oncontextmenu="openArtistContextMenu(event, '${safeArt}')">
                        <div class="w-12 h-12 rounded-full overflow-hidden shrink-0">
                            <img src="https://placehold.co/100x100/282828/fff?text=${art.substring(0,2)}" class="w-full h-full object-cover">
                        </div>
                        <div class="overflow-hidden min-w-0 flex-1">
                            <p class="text-white font-medium text-[15px] truncate">${art}</p>
                            <p class="text-[13px] text-spotify-text truncate">Artista</p>
                        </div>
                        <button class="text-spotify-text hover:text-red-400 focus:outline-none p-1.5 opacity-0 group-hover:opacity-100 transition shrink-0" onclick="event.stopPropagation(); toggleFollowArtist('${safeArt}')" title="Deixar de seguir">
                            <i class="ph-bold ph-user-minus text-lg"></i>
                        </button>
                    </div>`;
            });
        }
    }

    let searchTimeout;

    function showDesktopRecentSearches() {
        if (window.innerWidth >= 768 && appState.recentSearches.length > 0 && document.getElementById('queryInput').value.length === 0) {
            document.getElementById('desktopSearchDropdown').classList.remove('hidden');
            renderDesktopDropdown();
        }
    }

    function hideDesktopRecentSearches() {
        setTimeout(() => {
            const drop = document.getElementById('desktopSearchDropdown');
            if(drop) drop.classList.add('hidden');
        }, 200);
    }

    function renderDesktopDropdown() {
        const container = document.getElementById('desktopSearchDropdown');
        container.innerHTML = `<div class="px-3 pt-3 pb-2 text-xs font-bold tracking-wider text-white">Buscas recentes</div>`;
        appState.recentSearches.forEach(q => {
            container.innerHTML += `
                <div class="flex items-center justify-between group p-3 hover:bg-white/10 rounded-md cursor-pointer transition w-full" onclick="document.getElementById('queryInput').value='${q}'; hideDesktopRecentSearches(); performSearch('${q}')">
                    <div class="flex items-center gap-4 overflow-hidden flex-1 min-w-0">
                        <div class="w-10 h-10 rounded-full bg-[#181818] flex items-center justify-center shrink-0"><i class="ph-bold ph-clock text-white text-lg"></i></div>
                        <span class="text-white font-medium text-[15px] truncate">${q}</span>
                    </div>
                    <button class="text-spotify-text hover:text-white opacity-0 group-hover:opacity-100 transition p-1 focus:outline-none shrink-0" onclick="event.stopPropagation(); removeRecentSearch('${q}')"><i class="ph-bold ph-x text-lg"></i></button>
                </div>
            `;
        });
    }

    function handleSearchInput(e, source) {
        clearTimeout(searchTimeout);
        const inputEl = source === 'mobile' ? document.getElementById('mobileQueryInput') : document.getElementById('queryInput');
        const query = inputEl.value.trim();
        
        if (source === 'mobile') {
            document.getElementById('mobileClearSearchBtn').style.display = query.length > 0 ? 'block' : 'none';
            document.getElementById('queryInput').value = query; 
        } else {
            document.getElementById('clearSearchBtn').style.display = query.length > 0 ? 'block' : 'none';
            document.getElementById('mobileQueryInput').value = query; 
            if (query.length === 0) showDesktopRecentSearches();
            else hideDesktopRecentSearches();
        }
        
        if (currentView !== 'search' && query.length > 0 && source === 'desktop') navigateTo('search');
        
        if(appState.currentFilter === 'users') {
            if (e.key === 'Enter' && query.length > 0) {
                hideDesktopRecentSearches();
                performUserSearch(query);
            } else if (query.length > 2) {
                searchTimeout = setTimeout(() => { hideDesktopRecentSearches(); performUserSearch(query); }, 1500);
            }
            return;
        }

        if (e.key === 'Enter' && query.length > 0) {
            hideDesktopRecentSearches();
            performSearch(query);
        } else if (query.length > 2) {
            // Debounce reduzido: com AbortController protegendo contra respostas fora de ordem,
            // dá pra responder bem mais rápido sem risco de "flicker" de resultado antigo.
            searchTimeout = setTimeout(() => { hideDesktopRecentSearches(); performSearch(query); }, 400);
        } else if (query.length === 0) {
            renderSearchDefault();
        }
    }

    function clearDesktopSearch() {
        document.getElementById('queryInput').value = '';
        document.getElementById('clearSearchBtn').style.display = 'none';
        document.getElementById('mobileQueryInput').value = '';
        document.getElementById('mobileClearSearchBtn').style.display = 'none';
        renderSearchDefault();
        document.getElementById('queryInput').focus();
    }

    function clearMobileSearch() {
        clearDesktopSearch();
        document.getElementById('mobileQueryInput').focus();
    }

    function renderSearchDefault() {
        setHeaderColor('#121212');
        appState.displayLimit = 12;
        
        let recentsHtml = '';
        if (appState.recentSearches.length > 0) {
            let items = appState.recentSearches.map(q => `
                <div class="flex items-center justify-between group p-3 hover:bg-[#282828] rounded-md cursor-pointer transition w-full" onclick="document.getElementById('queryInput').value='${q}'; document.getElementById('mobileQueryInput').value='${q}'; performSearch('${q}')">
                    <div class="flex items-center gap-4 overflow-hidden flex-1 min-w-0">
                        <div class="w-12 h-12 rounded-full bg-[#242424] flex items-center justify-center shrink-0"><i class="ph-bold ph-clock text-white text-[22px]"></i></div>
                        <span class="text-white font-bold text-[16px] truncate">${q}</span>
                    </div>
                    <button class="text-spotify-text hover:text-white opacity-0 group-hover:opacity-100 transition p-2 shrink-0 focus:outline-none" onclick="event.stopPropagation(); removeRecentSearch('${q}')"><i class="ph-bold ph-x text-xl"></i></button>
                </div>
            `).join('');
            recentsHtml = `
                <div class="mb-10 mt-4 md:mt-0 fade-in w-full max-w-[1500px] mx-auto">
                    <h2 class="text-white text-2xl font-bold mb-4 tracking-tight">Buscas Recentes</h2>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">${items}</div>
                </div>
            `;
        }

        const categories = [
            {n: 'Podcasts', c: '#e13300'}, {n: 'Feito para você', c: '#1e3264'}, 
            {n: 'Lançamentos', c: '#e8115b'}, {n: 'Brasil', c: '#8d67ab'},
            {n: 'Sertanejo', c: '#509bf5'}, {n: 'Pop', c: '#148a08'}
        ];
        let catHtml = categories.map(cat => `
            <div class="relative overflow-hidden rounded-lg aspect-square cursor-pointer hover:opacity-90 transition-opacity" style="background-color: ${cat.c}" onclick="document.getElementById('${window.innerWidth<768 ? 'mobileQueryInput' : 'queryInput'}').focus()">
                <span class="absolute top-4 left-4 text-white font-bold text-xl sm:text-[24px] tracking-tight">${cat.n}</span>
                <img src="https://placehold.co/100x100/282828/fff?text=${cat.n.substring(0,3)}" class="absolute -bottom-2 -right-4 w-[100px] h-[100px] rotate-[25deg] shadow-xl rounded">
            </div>
        `).join('');

        dom.viewContainer.innerHTML = `
            ${recentsHtml}
            <div class="w-full max-w-[1500px] mx-auto">
                <h2 class="text-white text-2xl font-bold mb-4 ${recentsHtml ? '' : 'mt-4 md:mt-0'} fade-in tracking-tight">Navegar por todas as seções</h2>
                <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 sm:gap-6 fade-in pb-8">
                    ${catHtml}
                </div>
            </div>
        `;
    }

    function removeRecentSearch(query) {
        appState.recentSearches = appState.recentSearches.filter(q => q !== query);
        saveData();
        if(document.getElementById('queryInput').value.length === 0) {
            renderSearchDefault();
            if(window.innerWidth >= 768) renderDesktopDropdown();
        }
    }

    function renderSkeleton() {
        dom.viewContainer.innerHTML = `
            <div class="animate-pulse flex flex-col gap-10 w-full max-w-[1500px] mx-auto mt-4">
                <div class="flex gap-4 mb-2">
                    <div class="h-8 bg-[#282828] rounded-full w-24"></div>
                    <div class="h-8 bg-[#282828] rounded-full w-24"></div>
                    <div class="h-8 bg-[#282828] rounded-full w-24"></div>
                </div>
                <div class="flex flex-col xl:flex-row gap-8 w-full">
                    <div class="w-full xl:w-[40%]">
                        <div class="h-8 bg-[#282828] rounded w-1/3 mb-4"></div>
                        <div class="bg-[#181818] h-[180px] xl:h-[280px] rounded-lg p-5 flex items-center xl:flex-col xl:items-start gap-6">
                            <div class="w-24 h-24 xl:w-28 xl:h-28 rounded-full bg-[#282828] shrink-0"></div>
                            <div class="w-full flex-1 min-w-0 xl:flex-none xl:mt-auto">
                                <div class="h-10 bg-[#282828] rounded w-3/4 mb-4"></div>
                                <div class="h-5 bg-[#282828] rounded w-1/2"></div>
                            </div>
                        </div>
                    </div>
                    <div class="w-full xl:flex-1 flex flex-col gap-4">
                        <div class="h-8 bg-[#282828] rounded w-1/3 mb-2"></div>
                        ${Array(5).fill('<div class="flex gap-4 items-center w-full"><div class="w-12 h-12 bg-[#282828] rounded shrink-0"></div><div class="flex flex-col gap-2 w-full flex-1 min-w-0"><div class="h-4 bg-[#282828] rounded w-2/3"></div><div class="h-3 bg-[#282828] rounded w-1/3"></div></div></div>').join('')}
                    </div>
                </div>
            </div>`;
    }

    async function performSearch(query) {
        hideDesktopRecentSearches();
        appState.displayLimit = 12; // Reset on new search

        // Cancela qualquer busca anterior ainda em andamento (evita resultado antigo
        // "vencer" e sobrescrever um resultado mais novo — puramente UX/race-condition).
        if (PERF.currentSearchAbort) PERF.currentSearchAbort.abort();
        const abortController = new AbortController();
        PERF.currentSearchAbort = abortController;

        // STALE-WHILE-REVALIDATE: se já buscamos isso nos últimos minutos, mostra
        // instantaneamente os metadados em cache enquanto revalida em segundo plano.
        const cached = getCachedSearchResult(query);
        if (cached) {
            appState.lastSearchResult = cached;
            renderSearchResults(cached, query, true, true);
            warmTrackImages(cached);
        } else {
            renderSkeleton();
        }
        
        if (!appState.recentSearches.includes(query)) {
            appState.recentSearches.unshift(query);
            if(appState.recentSearches.length > 6) appState.recentSearches.pop();
            saveData();
        }
        
        try {
            // INTACTO: CHAMADA ORIGINAL (só adicionamos o `signal` do AbortController)
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
            cacheSearchResult(query, videos);
            renderSearchResults(videos, query, true);
            warmTrackImages(videos); // pré-aquece as thumbnails visíveis em segundo plano
        } catch (e) {
            if (e.name === 'AbortError') return; // busca mais nova já assumiu, ignora silenciosamente
            setTimeout(() => {
                const mockVideos = Array.from({length: 30}, (_, i) => ({
                    title: `${query} Hit Oficial ${i+1} Teste Longo Cortando Layout Título Gigantesco`,
                    url: `mock${i}`, duration: "3:45", thumbnail: `https://placehold.co/120x120/121212/fff?text=V${i+1}`, artist: "Canal Oficial"
                }));
                appState.lastSearchResult = mockVideos;
                renderSearchResults(mockVideos, query, true);
            }, 800); 
        }
    }

    // Busca de Usuários com Selo Verificado
    async function performUserSearch(query) {
        const queryEl = document.getElementById('queryInput').value || document.getElementById('mobileQueryInput').value;
        dom.viewContainer.innerHTML = `<div class="animate-pulse w-full h-20 bg-[#282828] rounded mt-12 max-w-2xl mx-auto"></div>`;
        try {
            const usersSnap = await db.collection('artifacts').doc('exlifyApp').collection('public').doc('data').collection('users').get();
            const matchedUsers = [];
            usersSnap.forEach(doc => {
                const data = doc.data();
                if(data.name && data.name.toLowerCase().includes(query.toLowerCase())) matchedUsers.push(data);
            });
            renderUserSearchResults(matchedUsers, query);
        } catch (e) {
            const mockUsers = [{name: 'Usuário ' + query, uid: 'mock_u1', verified: true, playlists: [{name: 'Playlist Pública', cover: DEFAULT_COVER}]}];
            renderUserSearchResults(mockUsers, query);
        }
    }

    function renderUserSearchResults(users, query) {
        const filtersHtml = `
            <div class="flex gap-2 mb-6 mt-2 overflow-x-auto pb-2 custom-scrollbar fade-in w-full max-w-[1500px] mx-auto">
                <button class="filter-chip bg-[#242424] hover:bg-[#2a2a2a] text-white px-4 py-1.5 rounded-full text-[13px] font-medium shrink-0 transition" data-filter="all" onclick="setFilter('all')">Tudo</button>
                <button class="filter-chip bg-[#242424] hover:bg-[#2a2a2a] text-white px-4 py-1.5 rounded-full text-[13px] font-medium transition shrink-0" data-filter="tracks" onclick="setFilter('tracks')">Músicas</button>
                <button class="filter-chip bg-white text-black px-4 py-1.5 rounded-full text-[13px] font-medium transition shrink-0" data-filter="users" onclick="setFilter('users')">Usuários</button>
            </div>`;

        if(users.length === 0) {
            dom.viewContainer.innerHTML = filtersHtml + `<h2 class="text-white text-2xl font-bold mb-4 mt-8 fade-in text-center">Nenhum usuário encontrado para "${query}"</h2>`;
            return;
        }
        
        let usersHtml = '<div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6 filterable-item" data-type="users">';
        users.forEach(u => {
            const verifBadge = getVerifiedHtml(u.verified);
            usersHtml += `
                <div class="bg-[#181818] hover:bg-[#282828] p-4 rounded-lg transition cursor-pointer flex flex-col items-center" onclick="navigateTo('profile', '${u.uid}')">
                    ${u.profileImage ? 
                        `<img src="${u.profileImage}" class="w-24 h-24 rounded-full object-cover mb-4 shadow-lg">` : 
                        `<div class="w-24 h-24 rounded-full bg-[#333] mb-4 flex items-center justify-center text-3xl font-bold text-white shadow-lg overflow-hidden">
                            ${(u.name || 'U').substring(0,1).toUpperCase()}
                        </div>`
                    }
                    <h3 class="text-white font-bold text-base truncate w-full text-center flex items-center justify-center">${u.name} ${verifBadge}</h3>
                    <p class="text-spotify-text text-sm">Perfil</p>
                </div>`;
        });
        usersHtml += '</div>';

        dom.viewContainer.innerHTML = filtersHtml + `
            <div class="w-full max-w-[1500px] mx-auto filterable-section">
                <h2 class="text-white text-2xl font-bold mb-6 tracking-tight filterable-item" data-type="users">Perfis</h2>
                ${usersHtml}
            </div>`;
    }

    async function renderUserProfile(userId) {
        setHeaderColor('#2a2a2a');
        dom.viewContainer.innerHTML = `<div class="animate-pulse w-full h-40 bg-[#282828] rounded mt-12 max-w-4xl mx-auto"></div>`;
        
        try {
            let userData = null;
            if (userId.startsWith('mock_')) {
                userData = {name: 'Usuário Teste', uid: userId, verified: true, playlists: [{id: 'p1', name: 'Sertanejo Pub', type:'shared', cover: DEFAULT_COVER, tracks: []}]};
            } else {
                const docRef = db.collection('artifacts').doc('exlifyApp').collection('public').doc('data').collection('users').doc(userId);
                const snap = await docRef.get();
                if(snap.exists) userData = snap.data();
            }

            if(!userData) {
                dom.viewContainer.innerHTML = `<h2 class="text-white text-2xl font-bold mt-12 text-center">Perfil não encontrado.</h2>`;
                return;
            }

            let plHtml = '';
            if(userData.playlists && userData.playlists.length > 0) {
                userData.playlists.forEach(pl => {
                    // Propaga o ID do dono na playlist para que funcione o clique nas playlists salvas
                    pl.ownerId = userData.uid;
                    pl.ownerVerified = userData.verified;
                    
                    plHtml += `
                        <div class="bg-[#181818] hover:bg-[#282828] p-4 rounded-lg transition cursor-pointer group flex flex-col" onclick="navigateTo('playlist', '${pl.id}')">
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
                                ${(userData.name || 'U').substring(0,1).toUpperCase()}
                            </div>`
                        }
                        <div class="flex-1 text-center md:text-left">
                            <span class="text-sm font-bold text-white uppercase tracking-wider mb-2 block">Perfil</span>
                            <h1 class="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black text-white mb-4 tracking-tighter w-full truncate flex items-center justify-center md:justify-start gap-4">
                                ${userData.name} ${userData.verified ? '<span class="bg-blue-500 text-white rounded-full w-10 h-10 flex items-center justify-center shadow-lg"><i class="ph-bold ph-check text-2xl"></i></span>' : ''}
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
        } catch(e) { console.log(e); dom.viewContainer.innerHTML = `<h2 class="text-white text-2xl text-center mt-12">Erro ao carregar perfil.</h2>`; }
    }

    window.saveSharedPlaylist = function(id, plData) {
        if(!appState.playlists.find(p => p.id === id)) {
            plData.type = 'shared';
            appState.playlists.push(plData);
            saveData();
            showToast(`Playlist "${plData.name}" foi salva!`);
        } else {
            showToast("Você já possui esta playlist.");
        }
    }

    function renderSearchResults(videos, query, updateQueue = false, fromCache = false) {
        if(!videos || videos.length === 0) {
            dom.viewContainer.innerHTML = `<h2 class="text-white text-2xl font-bold mb-4 mt-8 fade-in text-center">Nenhum resultado para "${query}"</h2>`;
            return;
        }

        if(updateQueue) {
            appState.queue = videos.map(v => {
                let extrArtist = v.artist || (v.author && v.author.name);
                if(!extrArtist && v.title && v.title.includes('-')) extrArtist = v.title.split('-')[0].trim();
                return {
                    id: v.url, title: v.title, artist: extrArtist || 'Canal Desconhecido', 
                    cover: v.thumbnail || DEFAULT_COVER, url: v.url, duration: v.duration
                };
            });
            appState.queueContext = 'search';
        }

        let tracksHtml = '';
        const limit = Math.min(appState.queue.length, appState.displayLimit);
        for(let index = 0; index < limit; index++) {
            tracksHtml += generateTrackRow(appState.queue[index], index, 'search');
        }

        const topResult = appState.queue[0];
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
                        ${appState.queue.length > limit ? `<button class="text-spotify-text hover:text-white font-bold text-sm mt-4 px-4 py-2 rounded-full border border-white/20 hover:border-white transition mx-auto block" onclick="loadMoreContent()">Mostrar Mais</button>` : ''}
                    </div>
                </div>
            </div>
        `;
        
        setFilter(appState.currentFilter);
        updateActiveTrackUI();
    }

    async function openArtistPlaylist(artistName) {
        renderSkeleton(); 
        try {
            // INTACTO
            const response = await fetch('/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: artistName })
            });
            const data = await response.json();
            renderArtistView(data.videos || [], artistName);
        } catch (e) {
            setTimeout(() => {
                const mock = Array.from({length: 12}, (_, i) => ({
                    title: `Top Upload ${i+1} de ${artistName}`, url: `mock_${i}`, duration: "3:30", thumbnail: `https://placehold.co/120x120/121212/fff?text=Art${i}`, artist: artistName
                }));
                renderArtistView(mock, artistName);
            }, 800);
        }
    }

    function toggleFollowArtist(artistName) {
        if(!checkAuth('seguir artistas')) return;
        const index = appState.followedArtists.indexOf(artistName);
        if(index > -1) { appState.followedArtists.splice(index, 1); showToast(`Deixou de seguir ${artistName}`); } 
        else { appState.followedArtists.push(artistName); showToast(`Seguindo ${artistName}`); }
        saveData();
        if(currentView === 'search' && appState.queueContext === 'artist_' + artistName) {
            const btn = document.getElementById('followArtistBtn');
            if(btn) btn.innerText = appState.followedArtists.includes(artistName) ? 'Seguindo' : 'Seguir';
        }
        if(currentView === 'library') renderLibraryMobile();
    }

    function renderArtistView(videos, artistName) {
        if(!videos || videos.length === 0) return showToast("Nenhum vídeo encontrado.");
        setHeaderColor('#509bf5'); 
        
        appState.queue = videos.map(v => ({
            id: v.url, title: v.title, artist: v.artist || artistName, 
            cover: v.thumbnail || DEFAULT_COVER, url: v.url, duration: v.duration
        }));
        appState.queueContext = 'artist_' + artistName;

        let tracksHtml = '';
        appState.queue.forEach((track, index) => { tracksHtml += generateTrackRow(track, index, appState.queueContext); });
        warmTrackImages(appState.queue);
        const isFollowed = appState.followedArtists.includes(artistName);

        dom.viewContainer.innerHTML = `
            <div class="w-full max-w-[1500px] mx-auto flex flex-col">
                <button class="md:hidden w-8 h-8 rounded-full bg-black/50 flex items-center justify-center text-white mb-2 self-start focus:outline-none" onclick="goBack()"><i class="ph-bold ph-caret-left text-lg"></i></button>

                <div class="mt-4 mb-6 flex flex-col md:flex-row items-center md:items-end gap-6 fade-in w-full">
                    <div class="w-48 h-48 md:w-[232px] md:h-[232px] rounded-full overflow-hidden shadow-[0_4px_60px_rgba(0,0,0,0.5)] bg-[#282828] shrink-0">
                        <img src="${appState.queue[0].cover}" loading="eager" decoding="async" class="w-full h-full object-cover" onerror="this.src='${DEFAULT_COVER}'">
                    </div>
                    <div class="flex-1 overflow-hidden text-center md:text-left min-w-0 w-full mt-2 md:mt-0">
                        <div class="flex items-center justify-center md:justify-start gap-2 mb-2">
                            <i class="ph-fill ph-check-circle text-blue-400 text-xl shadow-sm shrink-0"></i>
                            <span class="text-sm text-white font-medium shrink-0">Artista Verificado</span>
                        </div>
                        <h1 class="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black text-white mb-4 md:mb-2 tracking-tighter text-truncate-safe py-2 w-full">${artistName}</h1>
                        <span class="text-white/80 text-sm font-medium">${appState.queue.length} vídeos/músicas nesta lista</span>
                    </div>
                </div>
                
                <div class="py-4 flex items-center gap-6 mb-4 fade-in">
                    <button class="w-14 h-14 rounded-full bg-[#1ed760] text-black flex items-center justify-center hover:scale-[1.04] transition shadow-lg focus:outline-none shrink-0" onclick="playTrackFromContext('${appState.queueContext}', 0)">
                        <i class="ph-fill ph-play text-[24px] translate-x-[2px]"></i>
                    </button>
                    <button class="text-spotify-text hover:text-spotify-green transition focus:outline-none flex items-center justify-center shrink-0 tooltip" title="Ordem Aleatória" onclick="toggleShuffle(); this.querySelector('i').classList.toggle('text-spotify-green'); this.querySelector('i').classList.toggle('text-spotify-text');">
                        <i class="ph-bold ph-shuffle text-[32px] ${playerState.isShuffle ? 'text-spotify-green' : 'text-spotify-text'}"></i>
                    </button>
                    <button id="followArtistBtn" class="border border-white/50 text-white font-bold text-[13px] tracking-widest uppercase px-4 py-1.5 rounded-full hover:border-white hover:scale-105 transition focus:outline-none shrink-0 ml-2" onclick="toggleFollowArtist('${artistName.replace(/'/g, "\\'")}')">${isFollowed ? 'Seguindo' : 'Seguir'}</button>
                </div>
                <h2 class="text-white text-2xl font-bold mb-4 fade-in tracking-tight">Populares</h2>
                <div class="flex flex-col pb-20 fade-in w-full">${tracksHtml}</div>
            </div>
        `;
        updateActiveTrackUI();
    }

    function calculatePlaylistDuration(tracks) {
        if(!tracks || tracks.length === 0) return '';
        let totalSecs = 0;
        tracks.forEach(t => {
            if(t.duration) {
                const p = t.duration.split(':').reverse();
                let s = 0;
                if(p[0]) s += parseInt(p[0]); 
                if(p[1]) s += parseInt(p[1]) * 60; 
                if(p[2]) s += parseInt(p[2]) * 3600; 
                totalSecs += s;
            }
        });
        if(totalSecs === 0) return '';
        const h = Math.floor(totalSecs / 3600);
        const m = Math.floor((totalSecs % 3600) / 60);
        if (h > 0) return `, cerca de ${h} h ${m} min`;
        return `, cerca de ${m} min`;
    }

    function renderPlaylist(playlistId) {
        const pl = appState.playlists.find(p => p.id === playlistId);
        if(!pl) return navigateTo('home');
        
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
            for(let index = 0; index < limit; index++) {
                tracksHtml += generateTrackRow(pl.tracks[index], index, playlistId);
            }
            if(pl.tracks.length > limit) {
                tracksHtml += `<button class="text-spotify-text hover:text-white font-bold text-sm mt-4 px-4 py-2 rounded-full border border-white/20 hover:border-white transition mx-auto block" onclick="loadMoreContent()">Mostrar Mais</button>`;
            }
            warmTrackImages(pl.tracks); // pré-aquece capas da playlist em segundo plano
        }

        let ownerName = currentUser ? (currentUser.displayName || 'Você') : 'Exlify';
        let isOwnerVerified = appState.verified;
        let onOwnerClick = "";

        if (pl.type === 'shared') {
            if(pl.ownerName) ownerName = pl.ownerName;
            if(pl.ownerVerified) isOwnerVerified = pl.ownerVerified;
            if(pl.ownerId) onOwnerClick = `onclick="navigateTo('profile', '${pl.ownerId}')"`;
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
                        <h1 class="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black text-white mb-6 mt-2 tracking-tighter text-truncate-safe py-2 flex items-center justify-center md:justify-start gap-4 w-full">
                            <span class="truncate">${pl.name}</span>
                            ${isUserPl ? `<button class="text-white/50 hover:text-white transition focus:outline-none shrink-0" onclick="openEditPlaylistModal('${pl.id}', '${pl.name.replace(/'/g, "\\'")}')"><i class="ph-bold ph-pencil-simple text-3xl"></i></button>` : ''}
                        </h1>
                        <div class="flex items-center justify-center md:justify-start gap-2 text-[14px] overflow-hidden w-full">
                            <div class="w-6 h-6 rounded-full shrink-0 bg-[#1ed760] flex items-center justify-center text-black font-bold text-[10px] uppercase">${ownerName.substring(0,1)}</div>
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
                    
                    ${pl.id !== 'liked' ? `<button class="text-spotify-text hover:text-red-500 transition focus:outline-none ml-auto" onclick="deletePlaylist('${pl.id}')" title="Remover da Biblioteca"><i class="ph-bold ph-trash text-[30px]"></i></button>` : ''}
                </div>

                ${count > 0 ? `<div class="grid grid-cols-[30px_1fr_40px] md:grid-cols-[40px_4fr_3fr_minmax(120px,1fr)] gap-4 px-4 py-2 border-b border-white/10 text-sm text-spotify-text mb-4 sticky top-16 bg-[#121212]/95 backdrop-blur-sm z-10 font-medium fade-in hidden md:grid"><div class="text-center">#</div><div>Título</div><div>Álbum</div><div class="text-right flex items-center justify-end"><i class="ph-bold ph-clock text-[18px]"></i></div></div>` : ''}
                
                <div class="flex flex-col pb-20 fade-in w-full">${tracksHtml}</div>
            </div>
        `;
        updateActiveTrackUI();
    }

    window.deletePlaylist = function(id) {
        if(id === 'liked') return;
        if(confirm("Tem certeza que deseja remover esta playlist da sua biblioteca?")) {
            appState.playlists = appState.playlists.filter(p => p.id !== id);
            saveData();
            showToast("Playlist removida da biblioteca.");
            navigateTo('library');
        }
    }

    async function sharePlaylist(id) {
        const pl = appState.playlists.find(p => p.id === id);
        if (!pl) return;
        try {
            const plToShare = { 
                ...pl, 
                type: 'shared', 
                ownerName: currentUser ? currentUser.displayName : 'Usuário Exlify',
                ownerId: currentUser ? currentUser.uid : null,
                ownerVerified: appState.verified
            };
            await db.collection('shared_playlists').doc(id).set(plToShare);
            const url = window.location.href.split('?')[0] + "?shared_pl=" + id;
            navigator.clipboard.writeText(url).then(() => showToast("Link copiado! Outros podem salvar sua lista.")).catch(() => showToast("Erro ao copiar link."));
        } catch(e) {
            const url = window.location.href.split('?')[0] + "?shared_pl=" + id;
            navigator.clipboard.writeText(url);
            showToast("Link da Playlist gerado com sucesso!");
        }
    }
    
    function shareCurrentTrack() {
        if(appState.currentTrackIndex > -1) {
            const url = appState.queue[appState.currentTrackIndex].url;
            navigator.clipboard.writeText(url).then(() => showToast("Link da música copiado!"));
        }
    }

    function generateTrackRow(track, index, context) {
        const isPlaying = appState.queueContext === context && appState.currentTrackIndex === index;
        const rowClass = isPlaying ? "playing bg-white/10" : "hover:bg-[#2a2a2a] md:hover:bg-white/10";
        const numContent = isPlaying 
            ? `<img src="https://open.spotifycdn.com/cdn/images/equaliser-animated-green.f5eb96f2.gif" class="w-3.5 h-3.5 track-number">` 
            : `<span class="track-number text-[15px] font-medium">${index + 1}</span>`;
        
        const isLiked = appState.likedSongs.some(t => t.id === track.id);
        const heartClass = isLiked ? "ph-fill ph-heart text-[#1ed760]" : "ph-bold ph-heart text-spotify-text hover:text-white";
        const titleColor = isPlaying ? "text-[#1ed760]" : "text-white";

        const safeArtistName = (track.artist || 'Canal Desconhecido').replace(/'/g, "\\'"); 
        const safeTrackId = track.id.replace(/[^a-zA-Z0-9]/g, '');

        return `
            <div class="flex items-center gap-3 md:gap-4 px-2 md:px-4 py-2 md:py-2.5 rounded-md group transition cursor-pointer track-row ${rowClass} w-full overflow-hidden" 
                 data-context="${context}" data-index="${index}"
                 onclick="playTrackFromContext('${context}', ${index})" oncontextmenu="openContextMenu(event, '${context}', ${index})">
                
                <div class="text-center text-spotify-text relative w-8 flex items-center justify-center shrink-0 hidden md:flex track-num-container">
                    ${numContent}
                    <i class="ph-fill ph-play track-play-btn absolute text-white text-[18px]"></i>
                </div>
                
                <div class="flex items-center gap-3 overflow-hidden flex-1 min-w-0">
                    <img src="${track.cover || DEFAULT_COVER}" loading="lazy" decoding="async" class="w-12 h-12 md:w-10 md:h-10 object-cover rounded shadow shrink-0" onerror="this.src='${DEFAULT_COVER}'">
                    
                    <div class="flex flex-col justify-center overflow-hidden flex-1 min-w-0">
                        <span class="${titleColor} text-[15px] md:text-[14px] truncate font-medium track-title md:group-hover:underline w-full block">${track.title}</span>
                        <span class="text-[13px] text-spotify-text truncate hover:underline group-hover:text-white transition w-full block pointer-events-none md:pointer-events-auto" onclick="event.stopPropagation(); openArtistPlaylist('${safeArtistName}')">${track.artist}</span>
                    </div>
                </div>

                <div class="hidden md:block text-[14px] text-spotify-text truncate group-hover:text-white transition font-medium flex-1 min-w-0">
                    Exlify Single
                </div>

                <div class="text-right text-[14px] text-spotify-text flex items-center justify-end gap-3 md:gap-6 font-medium shrink-0">
                    <button class="group-hover:opacity-100 transition sm:block hidden focus:outline-none ${isLiked ? 'opacity-100' : 'opacity-0'}" onclick="event.stopPropagation(); toggleLikeTrackByContext('${context}', ${index})">
                        <i class="like-btn-${safeTrackId} ${heartClass} text-[18px] transition-colors duration-200"></i>
                    </button>
                    <span class="w-10 tabular-nums hidden sm:block text-right">${track.duration || '0:00'}</span>
                    <button class="opacity-0 group-hover:opacity-100 transition focus:outline-none md:block hidden" onclick="event.stopPropagation(); openContextMenu(event, '${context}', ${index})">
                        <i class="ph-bold ph-dots-three text-xl hover:text-white"></i>
                    </button>
                    <button class="block md:hidden text-spotify-text p-2 focus:outline-none" onclick="event.stopPropagation(); openContextMenu(event, '${context}', ${index})">
                        <i class="ph-bold ph-dots-three-vertical text-xl"></i>
                    </button>
                </div>
            </div>
        `;
    }

    function updateActiveTrackUI() {
        document.querySelectorAll('.track-row').forEach(row => {
            row.classList.remove('playing', 'bg-white/10');
            row.classList.add('hover:bg-[#2a2a2a]', 'md:hover:bg-white/10');
            
            const title = row.querySelector('.track-title');
            if(title) { title.classList.remove('text-[#1ed760]'); title.classList.add('text-white'); }
            
            const numCont = row.querySelector('.track-num-container');
            if(numCont) {
                const gif = numCont.querySelector('img');
                const span = numCont.querySelector('span');
                if(gif) gif.remove();
                if(span) span.style.display = 'inline-block';
            }
        });

        const activeRows = document.querySelectorAll(`.track-row[data-context="${appState.queueContext}"][data-index="${appState.currentTrackIndex}"]`);
        activeRows.forEach(row => {
            row.classList.add('playing', 'bg-white/10');
            row.classList.remove('hover:bg-[#2a2a2a]', 'md:hover:bg-white/10');
            
            const title = row.querySelector('.track-title');
            if(title) { title.classList.add('text-[#1ed760]'); title.classList.remove('text-white'); }
            
            const numCont = row.querySelector('.track-num-container');
            if(numCont) {
                const span = numCont.querySelector('span');
                if(span) span.style.display = 'none';
                if(!numCont.querySelector('img')) {
                    numCont.insertAdjacentHTML('afterbegin', `<img src="https://open.spotifycdn.com/cdn/images/equaliser-animated-green.f5eb96f2.gif" class="w-3.5 h-3.5 track-number">`);
                }
            }
        });
        
        if(isRightSidebarOpen) updateRightSidebar();
    }

    // =========================================================================
    // NOVA FUNÇÃO: PRE-FETCH (CARREGA NO BACKEND EM SEGUNDO PLANO)
    // =========================================================================
    function prefetchTrack(track) {
        if (!track || !track.url) return;
        
        // Faz a requisição sem travar a interface e sem dar o play
        // O servidor (server.js) vai extrair o áudio e guardar na memória RAM dele!
        fetch('/get-audio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                url: track.url,
                title: track.title,
                duration: track.duration,
                thumbnail: track.cover || track.thumbnail
            })
        }).catch(e => {
            // Se falhar o prefetch, não tem problema. Ignoramos o erro
            // pois o usuário nem sabe que isso está acontecendo no fundo.
        });
    }

    // --- CORE LÓGICA DE ÁUDIO INTACTA ---
    function playContext(playlistId) {
        if(playlistId === 'mock') return showToast("Este mix está vazio. Busque músicas!");
        const pl = appState.playlists.find(p => p.id === playlistId);
        if(!pl || !pl.tracks || pl.tracks.length === 0) return showToast("Playlist vazia");
        
        appState.queueContext = playlistId;
        appState.queue = [...pl.tracks];
        playTrackFromContext(playlistId, 0);
    }

    function playTrackFromContext(context, index) {
        if (appState.queueContext !== context) {
            if (context !== 'search' && !context.startsWith('artist_') && context !== 'trending') {
                const pl = appState.playlists.find(p => p.id === context);
                if(pl) appState.queue = [...pl.tracks];
            }
            appState.queueContext = context;
        }
        
        appState.currentTrackIndex = index;
        const track = appState.queue[index];
        loadAndPlayAudio(track);
        
        updateActiveTrackUI();
    }

    function setPlayerUIToTrack(track) {
        const safeCover = track.cover || DEFAULT_COVER;
        dom.playingTitle.innerText = track.title;
        dom.playingArtist.innerText = track.artist;
        dom.playerThumb.src = safeCover;
        dom.playerThumb.onerror = () => { dom.playerThumb.src = DEFAULT_COVER; };
        dom.mobileTitle.innerText = track.title;
        dom.mobileArtist.innerText = track.artist;
        dom.mobileThumb.src = safeCover;
        dom.mobileThumb.onerror = () => { dom.mobileThumb.src = DEFAULT_COVER; };
        dom.fsTitle.innerText = track.title;
        dom.fsArtist.innerText = track.artist;
        dom.fsThumb.src = safeCover;
        dom.fsThumb.onerror = () => { dom.fsThumb.src = DEFAULT_COVER; };
        document.getElementById('dsTitle').innerText = track.title;
        document.getElementById('dsArtist').innerText = track.artist;
        document.getElementById('dsThumb').src = safeCover;
        document.getElementById('dsBg').style.backgroundImage = `url(${safeCover})`;

        let ctxName = 'Exlify';
        if(appState.queueContext === 'search') ctxName = 'Resultados da Busca';
        else if(appState.queueContext === 'trending') ctxName = 'Em Alta';
        else if(appState.queueContext.startsWith('artist_')) ctxName = appState.queueContext.replace('artist_', '');
        else {
            const p = appState.playlists.find(x => x.id === appState.queueContext);
            if(p) ctxName = p.name;
        }
        dom.fsContextName.innerText = ctxName;
        
        if (isRightSidebarOpen) updateRightSidebar();
        updateLikeButtonUI();

        fetchAndDisplayLyrics(track);
    }

    async function loadAndPlayAudio(track) {
        dom.audio.pause();
        playerState.isLoading = true;
        dom.loadingOverlays.forEach(el => el.classList.remove('hidden'));
        
        setPlayerUIToTrack(track);
        saveLastPlayed(track);

        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title, artist: track.artist, album: 'Exlify',
                artwork: [{ src: track.cover || DEFAULT_COVER, sizes: '512x512', type: 'image/jpeg' }]
            });
            navigator.mediaSession.setActionHandler('play', togglePlayPause);
            navigator.mediaSession.setActionHandler('pause', togglePlayPause);
            navigator.mediaSession.setActionHandler('previoustrack', playPrev);
            navigator.mediaSession.setActionHandler('nexttrack', playNext);
            navigator.mediaSession.setActionHandler('seekbackward', playPrev);
            navigator.mediaSession.setActionHandler('seekforward', playNext);
        }

        if (playerState.isCasting && castSession) {
            castMedia(track);
            return;
        }

        try {
            // ROTA DE ÁUDIO INTACTA / ORIGINAL
            const response = await fetch('/get-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: track.url })
            });
            
            if (!response.ok) throw new Error("API Fail");
            const data = await response.json();
            
            if (data.audioUrl) {
                playSource(data.audioUrl);

                // =========================================================================
                // INÍCIO DO SISTEMA DE PRE-FETCH (Executado após iniciar a música atual)
                // =========================================================================
                setTimeout(() => {
                    if (!appState.queue || appState.queue.length === 0) return;

                    // 1. Descobrir a próxima música (levando em conta o modo aleatório)
                    let nextIdx = appState.currentTrackIndex + 1;
                    if (playerState.isShuffle) {
                        nextIdx = Math.floor(Math.random() * appState.queue.length);
                    }
                    if (nextIdx >= appState.queue.length) nextIdx = 0; // Volta pro começo se acabou
                    
                    const nextTrack = appState.queue[nextIdx];
                    if (nextTrack && nextTrack.url !== track.url) {
                        prefetchTrack(nextTrack);
                    }

                    // 2. Descobrir a música anterior (só se não for a primeira)
                    let prevIdx = appState.currentTrackIndex - 1;
                    if (prevIdx >= 0 && !playerState.isShuffle) {
                        const prevTrack = appState.queue[prevIdx];
                        if (prevTrack && prevTrack.url !== track.url) {
                            prefetchTrack(prevTrack);
                        }
                    }
                }, 1500); // Esperamos 1.5s para a internet baixar o inicio da música atual tranquilamente
                // =========================================================================
            }
        } catch (e) {
            console.log("Mock de áudio acionado (backend não respondendo)");
            setTimeout(() => { playSource("https://actions.google.com/sounds/v1/alarms/digital_watch_alarm_long.ogg"); }, 800);
        }
    }

    function playSource(audioSrc) {
        dom.audio.src = audioSrc;
        dom.audio.play().catch(e => {
            console.log("Autoplay blocked", e);
            dom.loadingOverlays.forEach(el => el.classList.add('hidden'));
        });
    }

    dom.audio.addEventListener('play', () => {
        playerState.isPlaying = true;
        playerState.isLoading = false;
        dom.loadingOverlays.forEach(el => el.classList.add('hidden'));

        const pClass = 'ph-fill ph-pause text-lg translate-x-[0px]';
        dom.iconPlayPause.className = pClass;
        dom.mobileIconPlay.className = 'ph-fill ph-pause text-[22px]';
        dom.fsIconPlayPause.className = 'ph-fill ph-pause text-[28px] translate-x-[0px]';
        dom.dsIconPlayPause.className = 'ph-fill ph-pause text-3xl lg:text-4xl translate-x-[0px]'; 
    });

    dom.audio.addEventListener('pause', () => {
        playerState.isPlaying = false;
        const pClass = 'ph-fill ph-play text-lg translate-x-[1px]';
        dom.iconPlayPause.className = pClass;
        dom.mobileIconPlay.className = 'ph-fill ph-play text-[22px]';
        dom.fsIconPlayPause.className = 'ph-fill ph-play text-[28px] translate-x-[2px]';
        dom.dsIconPlayPause.className = 'ph-fill ph-play text-3xl lg:text-4xl translate-x-[2px]'; 
    });

    dom.audio.addEventListener('loadedmetadata', () => {
        playerState.duration = dom.audio.duration;
        const t = formatTime(playerState.duration);
        dom.timeTotal.innerText = t;
        dom.fsTimeTotal.innerText = t;
    });

    dom.audio.addEventListener('timeupdate', () => {
        if (playerState.duration && !isSeeking) {
            const percent = (dom.audio.currentTime / playerState.duration) * 100;
            dom.progressSlider.value = percent;
            dom.fsProgressSlider.value = percent;
            updateProgressUI(percent);
            const t = formatTime(dom.audio.currentTime);
            dom.timeCurrent.innerText = t;
            dom.fsTimeCurrent.innerText = t;
        }
    });

    dom.audio.addEventListener('ended', () => {
        if (playerState.isRepeat) dom.audio.play();
        else playNext();
    });

    function togglePlayPause() {
        if (!appState.queue.length) return;
        if (playerState.isCasting && remotePlayerController) { remotePlayerController.playOrPause(); return; }
        if (playerState.isPlaying) dom.audio.pause();
        else dom.audio.play();
    }

    function playNext() {
        if (!appState.queue.length) return;
        let nextIdx = appState.currentTrackIndex + 1;
        if (playerState.isShuffle) nextIdx = Math.floor(Math.random() * appState.queue.length);
        if (nextIdx >= appState.queue.length) nextIdx = 0; 
        playTrackFromContext(appState.queueContext, nextIdx);
    }

    function playPrev() {
        if (dom.audio.currentTime > 3) dom.audio.currentTime = 0;
        else if (appState.currentTrackIndex > 0) playTrackFromContext(appState.queueContext, appState.currentTrackIndex - 1);
    }

    let isSeeking = false;
    function updateProgressUI(percent) {
        const fillColor = isProgressHovered ? '#1ed760' : '#fff';
        dom.progressSlider.style.background = `linear-gradient(to right, ${fillColor} ${percent}%, #4d4d4d ${percent}%)`;
        dom.fsProgressSlider.style.background = `linear-gradient(to right, ${fillColor} ${percent}%, #4d4d4d ${percent}%)`;
        dom.mobileProgressFill.style.width = `${percent}%`;
    }

    dom.progressContainer.addEventListener('mouseenter', () => { isProgressHovered = true; updateProgressUI(dom.progressSlider.value); });
    dom.progressContainer.addEventListener('mouseleave', () => { isProgressHovered = false; updateProgressUI(dom.progressSlider.value); });
    dom.fsProgressContainer.addEventListener('mouseenter', () => { isProgressHovered = true; updateProgressUI(dom.fsProgressSlider.value); });
    dom.fsProgressContainer.addEventListener('mouseleave', () => { isProgressHovered = false; updateProgressUI(dom.fsProgressSlider.value); });

    function seekingAudio(e) { isSeeking = true; updateProgressUI(e.target.value); }
    function seekAudioFinal(e) {
        if (!playerState.duration && !playerState.isCasting) return;
        const percent = e.target.value;
        if (playerState.isCasting && remotePlayer) {
            remotePlayer.currentTime = (percent / 100) * remotePlayer.duration;
            remotePlayerController.seek();
        } else dom.audio.currentTime = (percent / 100) * playerState.duration;
        isSeeking = false;
    }

    let isVolumeHovered = false;
    dom.volumeContainer.addEventListener('mouseenter', () => { isVolumeHovered = true; applyVolume(playerState.volume); });
    dom.volumeContainer.addEventListener('mouseleave', () => { isVolumeHovered = false; applyVolume(playerState.volume); });

    function updateVolume(e) { applyVolume(e.target.value / 100); }
    function applyVolume(vol) {
        playerState.volume = vol;
        playerState.isMuted = vol === 0;
        dom.audio.volume = vol;
        
        const percent = vol * 100;
        dom.volumeSlider.value = percent;
        
        const fillColor = isVolumeHovered ? '#1ed760' : '#fff';
        dom.volumeSlider.style.background = `linear-gradient(to right, ${fillColor} ${percent}%, #4d4d4d ${percent}%)`;
        
        if (playerState.isCasting && remotePlayer) {
            remotePlayer.volumeLevel = vol;
            remotePlayerController.setVolumeLevel();
        }

        if (vol === 0) dom.volIcon.className = "ph-bold ph-speaker-none text-[16px] hover:text-white cursor-pointer text-spotify-text";
        else if (vol < 0.5) dom.volIcon.className = "ph-bold ph-speaker-low text-[16px] hover:text-white cursor-pointer text-spotify-text";
        else dom.volIcon.className = "ph-bold ph-speaker-high text-[16px] hover:text-white cursor-pointer text-spotify-text";
    }
    function toggleMute() { applyVolume(playerState.isMuted ? (playerState.volume || 1) : 0); }

    function toggleShuffle() {
        playerState.isShuffle = !playerState.isShuffle;
        document.getElementById('iconShuffle').classList.toggle('text-spotify-green', playerState.isShuffle);
        document.getElementById('fsIconShuffle').classList.toggle('text-[#1ed760]', playerState.isShuffle);
    }
    function toggleRepeat() {
        playerState.isRepeat = !playerState.isRepeat;
        document.getElementById('iconRepeat').classList.toggle('text-spotify-green', playerState.isRepeat);
        document.getElementById('fsIconRepeat').classList.toggle('text-[#1ed760]', playerState.isRepeat);
    }

    function openFullscreenPlayer() { if(appState.currentTrackIndex > -1) dom.mobileFullscreenPlayer.classList.add('expanded'); }
    function closeFullscreenPlayer() { dom.mobileFullscreenPlayer.classList.remove('expanded'); }
    
    function openDesktopScreensaver() {
        if(appState.currentTrackIndex === -1) return;
        const ds = dom.desktopScreensaver;
        ds.classList.remove('hidden');
        ds.focus();
        setTimeout(() => { ds.classList.remove('opacity-0'); }, 10);
        ds.addEventListener('keydown', handleDsEscape);
    }
    function closeDesktopScreensaver() {
        const ds = dom.desktopScreensaver;
        ds.classList.add('opacity-0');
        setTimeout(() => { ds.classList.add('hidden'); }, 500);
        ds.removeEventListener('keydown', handleDsEscape);
    }
    function handleDsEscape(e) { if(e.key === 'Escape') closeDesktopScreensaver(); }

    let isRightSidebarOpen = false;
    function toggleRightSidebar() {
        if(window.innerWidth < 768) return; 
        isRightSidebarOpen = !isRightSidebarOpen;
        const rs = document.getElementById('rightSidebar');
        const icon = document.getElementById('rightSidebarIcon');
        
        if (isRightSidebarOpen) {
            rs.style.display = 'flex';
            icon.classList.add('text-spotify-green');
            updateRightSidebar();
        } else {
            rs.style.display = 'none';
            icon.classList.remove('text-spotify-green');
        }
        
        if(currentView === 'search') {
            renderSearchResults(appState.lastSearchResult || [], document.getElementById('queryInput').value, false);
        }
    }

    function switchRightSidebarTab(tab) {
        const btnDet = document.getElementById('rsTabBtnDetails');
        const btnLyr = document.getElementById('rsTabBtnLyrics');
        const contDet = document.getElementById('rsContentDetails');
        const contLyr = document.getElementById('rsContentLyrics');

        if(tab === 'details') {
            btnDet.className = "text-white font-bold text-sm border-b-2 border-[#1ed760] pb-2 transition focus:outline-none";
            btnLyr.className = "text-spotify-text hover:text-white font-bold text-sm border-b-2 border-transparent pb-2 transition focus:outline-none";
            contDet.classList.remove('hidden'); contDet.classList.add('flex');
            contLyr.classList.add('hidden'); contLyr.classList.remove('flex');
        } else {
            btnLyr.className = "text-white font-bold text-sm border-b-2 border-[#1ed760] pb-2 transition focus:outline-none";
            btnDet.className = "text-spotify-text hover:text-white font-bold text-sm border-b-2 border-transparent pb-2 transition focus:outline-none";
            contLyr.classList.remove('hidden'); contLyr.classList.add('flex');
            contDet.classList.add('hidden'); contDet.classList.remove('flex');
            
            if(appState.currentTrackIndex > -1) {
                fetchAndDisplayLyrics(appState.queue[appState.currentTrackIndex]);
            }
        }
    }

    async function fetchAndDisplayLyrics(track) {
        const rsContainer = document.getElementById('rsLyricsText');
        const mobContainer = document.getElementById('mobileLyricsText');
        const loadingHtml = '<div class="flex flex-col items-center justify-center py-10 text-white/50"><i class="ph-bold ph-spinner animate-spin text-3xl mb-2"></i><span>Buscando letras...</span></div>';
        
        if(rsContainer) rsContainer.innerHTML = loadingHtml;
        if(mobContainer) mobContainer.innerHTML = loadingHtml;
        
        try {
            let cleanTitle = track.title.split('-')[0].replace(/official|video|lyric|audio|clip|\(.*\)|\[.*\]/gi, '').trim();
            let cleanArtist = track.artist.replace(/official|vevo/gi, '').trim();
            
            const res = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(cleanArtist)}/${encodeURIComponent(cleanTitle)}`);
            if(res.ok) {
                const data = await res.json();
                if(data.lyrics) {
                    const formatted = data.lyrics.replace(/\n\n/g, '</p><p class="mt-6">').replace(/\n/g, '<br>');
                    const html = `<p class="lyrics-line">${formatted}</p>`;
                    if(rsContainer) rsContainer.innerHTML = html;
                    if(mobContainer) mobContainer.innerHTML = html;
                    return;
                }
            }
            throw new Error("Not found");
        } catch (e) {
            const fallbackHtml = `
                <p class="lyrics-line text-[#1ed760]">♪ Letra não sincronizada ♪</p>
                <p class="text-white/70 text-sm mt-4 font-normal">Parece que não encontramos a letra exata na nossa base de dados para <b class="text-white">${track.title}</b>.</p>
                <p class="text-white/70 text-sm mt-4 font-normal">Sinta a melodia e aproveite a música!</p>
            `;
            if(rsContainer) rsContainer.innerHTML = fallbackHtml;
            if(mobContainer) mobContainer.innerHTML = fallbackHtml;
        }
    }

    function updateRightSidebar() {
        if(appState.currentTrackIndex === -1) return;
        const track = appState.queue[appState.currentTrackIndex];
        
        document.getElementById('rsThumb').src = track.cover || DEFAULT_COVER;
        document.getElementById('rsTitle').innerText = track.title;
        document.getElementById('rsArtist').innerText = track.artist;
        
        document.getElementById('rsSmallThumb').src = track.cover || DEFAULT_COVER;
        document.getElementById('rsSmallTitle').innerText = track.title;
        
        let ctxName = 'Exlify';
        if(appState.queueContext === 'search') ctxName = 'Busca';
        else if(appState.queueContext === 'trending') ctxName = 'Em Alta';
        else if(appState.queueContext.startsWith('artist_')) ctxName = appState.queueContext.replace('artist_', '');
        else {
            const p = appState.playlists.find(x => x.id === appState.queueContext);
            if(p) ctxName = p.name;
        }
        document.getElementById('rsContextName').innerText = ctxName;
        
        const isLiked = appState.likedSongs.some(t => t.id === track.id);
        document.getElementById('rsLikeIcon').className = isLiked ? "ph-fill ph-heart text-spotify-green text-[24px]" : "ph-bold ph-heart text-spotify-text text-[24px] hover:text-white";

        if(!document.getElementById('rsContentLyrics').classList.contains('hidden')) {
            fetchAndDisplayLyrics(track);
        }
    }

    function formatTime(seconds) {
        if (isNaN(seconds)) return "0:00";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function toggleLikeCurrent() {
        if(appState.currentTrackIndex === -1) return;
        toggleLikeTrack(appState.queue[appState.currentTrackIndex]);
    }

    function toggleLikeTrackByContext(context, index) {
        let track;
        if (context === 'search' || context.startsWith('artist_') || context === 'trending') track = appState.queue[index];
        else {
            const pl = appState.playlists.find(p => p.id === context);
            if(pl) track = pl.tracks[index];
        }
        if(track) toggleLikeTrack(track);
    }

    function toggleLikeTrack(track) {
        if(!checkAuth('curtir músicas')) return;
        const index = appState.likedSongs.findIndex(t => t.id === track.id);
        if (index > -1) {
            appState.likedSongs.splice(index, 1);
            showToast("Removido das Músicas Curtidas");
        } else {
            appState.likedSongs.unshift(track);
            showToast("Adicionado às Músicas Curtidas");
        }
        saveData();
        updateLikeButtonUI();
        if (isRightSidebarOpen) updateRightSidebar();
        
        const safeTrackId = track.id.replace(/[^a-zA-Z0-9]/g, '');
        document.querySelectorAll(`.like-btn-${safeTrackId}`).forEach(icon => {
            if (index > -1) { 
                icon.className = `like-btn-${safeTrackId} ph-bold ph-heart text-spotify-text hover:text-white text-[18px] transition-colors duration-200`;
                icon.parentElement.classList.remove('opacity-100');
                icon.parentElement.classList.add('opacity-0');
            } else { 
                icon.className = `like-btn-${safeTrackId} ph-fill ph-heart text-[#1ed760] text-[18px] transition-colors duration-200`;
                icon.parentElement.classList.remove('opacity-0');
                icon.parentElement.classList.add('opacity-100');
            }
        });
    }

    function updateLikeButtonUI() {
        if(appState.currentTrackIndex === -1) return;
        const track = appState.queue[appState.currentTrackIndex];
        const isLiked = appState.likedSongs.some(t => t.id === track.id);
        const classHeart = isLiked ? "ph-fill ph-heart text-[#1ed760]" : "ph-bold ph-heart hover:text-white text-spotify-text";
        
        dom.playerLikeIcon.className = `${classHeart} text-[16px]`;
        dom.fsLikeIcon.className = `${classHeart} text-[32px]`;
    }

    // --- FILA DE REPRODUÇÃO MODAL ---
    let dragSourceIndex = null;

    function openQueueModal() {
        if(appState.queue.length === 0) return showToast("Fila vazia.");
        const modal = document.getElementById('queueModal');
        
        const currentTrack = appState.queue[appState.currentTrackIndex];
        document.getElementById('queueNowPlaying').innerHTML = `
            <div class="flex items-center gap-3 w-full overflow-hidden">
                <img src="${currentTrack.cover || DEFAULT_COVER}" class="w-12 h-12 rounded object-cover shadow shrink-0">
                <div class="flex flex-col justify-center overflow-hidden flex-1 min-w-0">
                    <span class="text-[#1ed760] text-[15px] truncate font-medium w-full block">${currentTrack.title}</span>
                    <span class="text-[13px] text-spotify-text truncate w-full block">${currentTrack.artist}</span>
                </div>
            </div>
        `;

        let nextHtml = '';
        let startIndex = appState.currentTrackIndex + 1;
        let displayCount = 0;
        
        if(playerState.isShuffle) {
            nextHtml = `<p class="text-spotify-text text-sm p-2">Modo aleatório ativado. Ordem surpresa!</p>`;
        } else {
            for(let i = startIndex; i < appState.queue.length && displayCount < 20; i++) {
                const track = appState.queue[i];
                nextHtml += `
                    <div class="flex items-center gap-2 p-2 hover:bg-white/10 rounded-md transition w-full overflow-hidden queue-item group" 
                         draggable="true" data-qindex="${i}"
                         ondragstart="dragSourceIndex=${i}; this.classList.add('opacity-40')"
                         ondragend="this.classList.remove('opacity-40')"
                         ondragover="event.preventDefault(); this.classList.add('queue-drag-over')"
                         ondragleave="this.classList.remove('queue-drag-over')"
                         ondrop="event.preventDefault(); this.classList.remove('queue-drag-over'); moveQueueItem(dragSourceIndex, ${i})">
                        <i class="ph-bold ph-dots-six-vertical text-spotify-text text-lg cursor-grab shrink-0 opacity-0 group-hover:opacity-100 transition"></i>
                        <span class="text-spotify-text text-xs w-4 shrink-0 text-center">${i+1}</span>
                        <img src="${track.cover || DEFAULT_COVER}" loading="lazy" decoding="async" class="w-10 h-10 rounded object-cover shadow shrink-0 cursor-pointer" onclick="jumpToQueueIndex(${i})">
                        <div class="flex flex-col justify-center overflow-hidden flex-1 min-w-0 cursor-pointer" onclick="jumpToQueueIndex(${i})">
                            <span class="text-white text-[14px] truncate font-medium w-full block">${track.title}</span>
                            <span class="text-[12px] text-spotify-text truncate w-full block">${track.artist}</span>
                        </div>
                        <button class="text-spotify-text hover:text-white opacity-0 group-hover:opacity-100 transition p-1 shrink-0 focus:outline-none" onclick="event.stopPropagation(); removeFromQueue(${i})" title="Remover da fila">
                            <i class="ph-bold ph-x text-base"></i>
                        </button>
                    </div>`;
                displayCount++;
            }
            if(nextHtml === '') nextHtml = `<p class="text-spotify-text text-sm p-2">Fim da fila.</p>`;
        }

        document.getElementById('queueNextList').innerHTML = nextHtml;

        modal.classList.remove('hidden');
        setTimeout(() => { modal.classList.remove('opacity-0'); document.getElementById('queueContent').classList.remove('scale-95'); }, 10);
        if(dom.mobileFullscreenPlayer.classList.contains('expanded')) closeFullscreenPlayer();
    }

    // Reordena a fila (drag-and-drop). Mantém a faixa em reprodução corretamente
    // "grudada" nela mesma mesmo depois do reordenamento (localiza por referência).
    function moveQueueItem(fromIndex, toIndex) {
        if (fromIndex === null || fromIndex === toIndex) return;
        const currentTrackRef = appState.queue[appState.currentTrackIndex];
        const [moved] = appState.queue.splice(fromIndex, 1);
        appState.queue.splice(toIndex, 0, moved);
        appState.currentTrackIndex = appState.queue.indexOf(currentTrackRef);
        dragSourceIndex = null;
        openQueueModal();
    }

    function removeFromQueue(index) {
        if (index === appState.currentTrackIndex) { showToast("Não é possível remover a faixa que está tocando."); return; }
        const currentTrackRef = appState.queue[appState.currentTrackIndex];
        appState.queue.splice(index, 1);
        appState.currentTrackIndex = appState.queue.indexOf(currentTrackRef);
        showToast("Removida da fila.");
        openQueueModal();
    }

    // Pula direto pra uma faixa específica já presente na fila (reusa o pipeline de áudio intacto).
    function jumpToQueueIndex(index) {
        playTrackFromContext(appState.queueContext, index);
        closeQueueModal();
    }

    // "Tocar a seguir" — insere uma faixa logo após a atual na fila (não busca nem baixa nada novo).
    function playTrackNext(track) {
        if (!track) return;
        const insertAt = appState.currentTrackIndex > -1 ? appState.currentTrackIndex + 1 : appState.queue.length;
        appState.queue.splice(insertAt, 0, track);
        showToast(`"${track.title}" vai tocar a seguir.`);
    }

    function closeQueueModal() {
        const modal = document.getElementById('queueModal');
        modal.classList.add('opacity-0');
        document.getElementById('queueContent').classList.add('scale-95');
        setTimeout(() => { modal.classList.add('hidden'); }, 200);
    }

    let contextTrackTarget = null;
    function openContextMenu(e, context, index) {
        e.preventDefault(); e.stopPropagation();
        let track;
        const isUserPlaylist = appState.playlists.some(p => p.id === context && p.type === 'user');

        if (context === 'search' || context.startsWith('artist_') || context === 'trending') track = appState.queue[index];
        else {
            const pl = appState.playlists.find(p => p.id === context);
            if(pl) track = pl.tracks[index];
        }
        if(!track) return;
        contextTrackTarget = track;

        const menu = document.getElementById('contextMenu');
        
        // Reset dynamic buttons inside menu, keep standard
        const isLiked = appState.likedSongs.some(t => t.id === track.id);
        menu.innerHTML = `
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="contextAction('like')">
                <i id="contextLikeIcon" class="ph-bold ph-heart text-lg ${isLiked ? 'text-spotify-green ph-fill' : 'text-spotify-text'}"></i> 
                <span id="contextLikeText">${isLiked ? "Remover das Curtidas" : "Curtir"}</span>
            </button>
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="openSelectPlaylistModal()">
                <i class="ph-bold ph-list-plus text-lg"></i> Adicionar à playlist
            </button>
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="contextAction('play_next')">
                <i class="ph-bold ph-queue text-lg"></i> Tocar a seguir
            </button>
        `;

        if(isUserPlaylist) {
            menu.innerHTML += `
                <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition text-red-400" onclick="removeTrackFromPlaylist('${context}', '${track.id}')">
                    <i class="ph-bold ph-trash text-lg"></i> Remover desta playlist
                </button>
            `;
        }

        menu.innerHTML += `
            <div class="h-[1px] bg-white/10 my-1 mx-2"></div>
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="contextAction('cast')">
                <i class="ph-bold ph-screencast text-lg"></i> Transmitir
            </button>
        `;

        menu.style.display = 'block';
        menu.style.left = `${Math.min(e.pageX, window.innerWidth - 224)}px`;
        menu.style.top = `${Math.min(e.pageY, window.innerHeight - menu.offsetHeight)}px`;
        
        document.addEventListener('click', closeContextMenu);
    }

    // =========================================================================
    // NOVO: MENU DE CONTEXTO (clique direito) PARA PLAYLISTS E ARTISTAS
    // Reaproveita as funções já existentes (openEditPlaylistModal, deletePlaylist,
    // sharePlaylist, toggleFollowArtist) — não duplica nem altera lógica nenhuma.
    // =========================================================================
    function openPlaylistContextMenu(e, id) {
        e.preventDefault(); e.stopPropagation();
        const pl = appState.playlists.find(p => p.id === id);
        if (!pl) return;
        const isUserPl = pl.type === 'user';
        const safeName = (pl.name || '').replace(/'/g, "\\'");
        const menu = document.getElementById('contextMenu');

        let html = `
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="navigateTo('playlist', '${id}'); closeContextMenu();">
                <i class="ph-fill ph-play-circle text-lg"></i> Abrir playlist
            </button>
        `;
        if (isUserPl) {
            html += `
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="openEditPlaylistModal('${id}', '${safeName}'); closeContextMenu();">
                <i class="ph-bold ph-pencil-simple text-lg"></i> Editar detalhes
            </button>`;
        }
        if (pl.type !== 'system' && pl.type !== 'youtube') {
            html += `
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="sharePlaylist('${id}'); closeContextMenu();">
                <i class="ph-bold ph-share-network text-lg"></i> Compartilhar
            </button>`;
        }
        if (id !== 'liked') {
            html += `
            <div class="h-[1px] bg-white/10 my-1 mx-2"></div>
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none text-red-400" onclick="closeContextMenu(); deletePlaylist('${id}');">
                <i class="ph-bold ph-trash text-lg"></i> Excluir da biblioteca
            </button>`;
        }

        menu.innerHTML = html;
        menu.style.display = 'block';
        menu.style.left = `${Math.min(e.pageX, window.innerWidth - 224)}px`;
        menu.style.top = `${Math.min(e.pageY, window.innerHeight - menu.offsetHeight - 10)}px`;
        document.addEventListener('click', closeContextMenu);
    }

    function openArtistContextMenu(e, artistName) {
        e.preventDefault(); e.stopPropagation();
        const safe = artistName.replace(/'/g, "\\'");
        const menu = document.getElementById('contextMenu');
        menu.innerHTML = `
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="openArtistPlaylist('${safe}'); closeContextMenu();">
                <i class="ph-bold ph-user text-lg"></i> Ver artista
            </button>
            <div class="h-[1px] bg-white/10 my-1 mx-2"></div>
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none text-red-400" onclick="closeContextMenu(); toggleFollowArtist('${safe}');">
                <i class="ph-bold ph-user-minus text-lg"></i> Deixar de seguir
            </button>
        `;
        menu.style.display = 'block';
        menu.style.left = `${Math.min(e.pageX, window.innerWidth - 224)}px`;
        menu.style.top = `${Math.min(e.pageY, window.innerHeight - menu.offsetHeight - 10)}px`;
        document.addEventListener('click', closeContextMenu);
    }

    function removeTrackFromPlaylist(playlistId, trackId) {
        const pl = appState.playlists.find(p => p.id === playlistId);
        if(pl) {
            pl.tracks = pl.tracks.filter(t => t.id !== trackId);
            saveData();
            showToast("Música removida da playlist");
            if(currentView === 'playlist' && appState.history[appState.historyIndex].data === playlistId) {
                renderPlaylist(playlistId);
            }
        }
        closeContextMenu();
    }

    function closeContextMenu() { document.getElementById('contextMenu').style.display = 'none'; document.removeEventListener('click', closeContextMenu); }

    // Menu de opções da faixa que está tocando agora, acessível pela barra do player
    // (telas maiores). Lê direto de appState.queue[currentTrackIndex] — sempre correto,
    // mesmo depois de reordenar a fila manualmente (drag-and-drop).
    function openNowPlayingMenu(e) {
        e.preventDefault(); e.stopPropagation();
        if (appState.currentTrackIndex === -1) return;
        const track = appState.queue[appState.currentTrackIndex];
        if (!track) return;
        contextTrackTarget = track;

        const isLiked = appState.likedSongs.some(t => t.id === track.id);
        const menu = document.getElementById('contextMenu');
        menu.innerHTML = `
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="contextAction('like')">
                <i class="ph-bold ph-heart text-lg ${isLiked ? 'text-spotify-green ph-fill' : 'text-spotify-text'}"></i>
                <span>${isLiked ? "Remover das Curtidas" : "Curtir"}</span>
            </button>
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="openSelectPlaylistModal()">
                <i class="ph-bold ph-list-plus text-lg"></i> Adicionar à playlist
            </button>
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="handleArtistClickFromPlayer(); closeContextMenu();">
                <i class="ph-bold ph-user text-lg"></i> Ir para o artista
            </button>
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="openQueueModal(); closeContextMenu();">
                <i class="ph-bold ph-list-numbers text-lg"></i> Ver fila
            </button>
            <div class="h-[1px] bg-white/10 my-1 mx-2"></div>
            <button class="w-full text-left px-3 py-2.5 hover:bg-white/10 rounded-sm flex items-center gap-3 transition focus:outline-none" onclick="contextAction('cast')">
                <i class="ph-bold ph-screencast text-lg"></i> Transmitir
            </button>
        `;
        menu.style.display = 'block';
        menu.style.left = `${Math.min(e.pageX, window.innerWidth - 224)}px`;
        menu.style.top = `${Math.min(e.pageY, window.innerHeight - menu.offsetHeight - 10)}px`;
        document.addEventListener('click', closeContextMenu);
    }

    function contextAction(action) {
        if(action === 'like') toggleLikeTrack(contextTrackTarget);
        if(action === 'cast') showToast("Selecione o dispositivo no ícone Google Cast no topo do player.");
        if(action === 'play_next') playTrackNext(contextTrackTarget);
        closeContextMenu();
    }

    function openSelectPlaylistModal() {
        if(!checkAuth('salvar em playlists')) return;
        closeContextMenu();
        const modal = document.getElementById('selectPlaylistModal');
        const list = document.getElementById('selectPlaylistList');
        list.innerHTML = '';
        
        const userPlaylists = appState.playlists.filter(p => p.type === 'user');
        if(userPlaylists.length === 0) list.innerHTML = `<div class="text-spotify-text text-sm py-4 text-center">Você ainda não tem playlists criadas.</div>`;
        else {
            userPlaylists.forEach(pl => {
                const trackExists = pl.tracks.some(t => t.id === contextTrackTarget.id);
                list.innerHTML += `
                    <label class="w-full flex items-center justify-between p-2 hover:bg-white/10 rounded-md transition cursor-pointer">
                        <div class="flex items-center gap-4 overflow-hidden">
                            <img src="${pl.cover || DEFAULT_COVER}" class="w-12 h-12 rounded object-cover shadow">
                            <div class="flex flex-col text-left overflow-hidden">
                                <span class="text-white font-bold text-[15px] truncate">${pl.name}</span>
                                <span class="text-spotify-text text-[13px]">${pl.tracks.length} músicas</span>
                            </div>
                        </div>
                        <input type="checkbox" value="${pl.id}" ${trackExists ? 'checked' : ''} class="multi-playlist-checkbox w-5 h-5 accent-spotify-green rounded bg-[#3e3e3e] border-none">
                    </label>`;
            });
        }
        modal.classList.remove('hidden');
        setTimeout(() => { modal.classList.remove('opacity-0'); document.getElementById('selectPlaylistContent').classList.remove('scale-95'); }, 10);
    }

    function closeSelectPlaylistModal() {
        const modal = document.getElementById('selectPlaylistModal');
        modal.classList.add('opacity-0');
        document.getElementById('selectPlaylistContent').classList.add('scale-95');
        setTimeout(() => { modal.classList.add('hidden'); }, 200);
    }

    function saveToSelectedPlaylists() {
        if(!contextTrackTarget) return;
        const checkboxes = document.querySelectorAll('.multi-playlist-checkbox');
        
        let changes = 0;
        checkboxes.forEach(cb => {
            const pl = appState.playlists.find(p => p.id === cb.value);
            if(pl) {
                const exists = pl.tracks.some(t => t.id === contextTrackTarget.id);
                if(cb.checked && !exists) {
                    pl.tracks.push(contextTrackTarget);
                    changes++;
                } else if(!cb.checked && exists) {
                    pl.tracks = pl.tracks.filter(t => t.id !== contextTrackTarget.id);
                    changes++;
                }
            }
        });
        
        if(changes > 0) {
            saveData(); 
            showToast(`Música alterada em suas playlists!`);
        }
        closeSelectPlaylistModal();
    }

    function openTimerModal() {
        document.getElementById('timerModal').classList.remove('hidden');
        setTimeout(() => { document.getElementById('timerModal').classList.remove('opacity-0'); document.getElementById('timerContent').classList.remove('scale-95'); }, 10);
        if(dom.mobileFullscreenPlayer.classList.contains('expanded')) closeFullscreenPlayer();
    }
    function closeTimerModal() {
        document.getElementById('timerModal').classList.add('opacity-0'); document.getElementById('timerContent').classList.add('scale-95');
        setTimeout(() => { document.getElementById('timerModal').classList.add('hidden'); }, 200);
    }
    function setSleepTimer(mins) {
        clearTimeout(sleepTimerRef);
        closeTimerModal();
        if(mins === 0) { showToast("Sleep Timer desativado"); return; }
        showToast(`Áudio pausará em ${mins} minutos`);
        sleepTimerRef = setTimeout(() => { dom.audio.pause(); showToast("Sleep Timer: Áudio pausado"); }, mins * 60000);
    }

    function openCreatePlaylistModal() {
        if(!checkAuth('criar playlists')) return;
        document.getElementById('createPlaylistModal').classList.remove('hidden');
        setTimeout(() => {
            document.getElementById('createPlaylistModal').classList.remove('opacity-0');
            document.getElementById('createPlaylistContent').classList.remove('scale-95');
            document.getElementById('newPlaylistName').focus();
        }, 10);
    }
    function closeCreatePlaylistModal() {
        document.getElementById('createPlaylistModal').classList.add('opacity-0');
        document.getElementById('createPlaylistContent').classList.add('scale-95');
        setTimeout(() => { document.getElementById('createPlaylistModal').classList.add('hidden'); document.getElementById('newPlaylistName').value = ''; }, 200);
    }
    function createPlaylist() {
        const name = document.getElementById('newPlaylistName').value.trim() || 'Minha Playlist #' + (appState.playlists.length);
        const privacy = document.getElementById('newPlaylistPrivacy').value;
        const newPl = {
            id: 'pl_' + Date.now(), name: name, type: 'user', isPublic: privacy === 'public',
            cover: 'https://placehold.co/300x300/282828/fff?text=' + name.charAt(0).toUpperCase(), tracks: []
        };
        appState.playlists.push(newPl);
        saveData();
        closeCreatePlaylistModal();
        showToast("Playlist adicionada à Sua Biblioteca");
        navigateTo('playlist', newPl.id);
    }

    let pendingPlaylistImageFile = null;
    function openEditPlaylistModal(id, currentName) {
        const pl = appState.playlists.find(p => p.id === id);
        if(!pl) return;
        
        document.getElementById('editPlaylistId').value = id; 
        document.getElementById('editPlaylistName').value = pl.name;
        document.getElementById('editPlaylistPrivacy').value = pl.isPublic ? 'public' : 'private';
        document.getElementById('editPlaylistPreview').src = pl.cover || DEFAULT_COVER;
        pendingPlaylistImageFile = null;

        document.getElementById('editPlaylistModal').classList.remove('hidden');
        setTimeout(() => { document.getElementById('editPlaylistModal').classList.remove('opacity-0'); document.getElementById('editPlaylistContent').classList.remove('scale-95'); document.getElementById('editPlaylistName').focus(); }, 10);
    }
    function closeEditPlaylistModal() {
        document.getElementById('editPlaylistModal').classList.add('opacity-0'); document.getElementById('editPlaylistContent').classList.add('scale-95');
        setTimeout(() => { document.getElementById('editPlaylistModal').classList.add('hidden'); }, 200);
    }
    function previewPlaylistImage(e) {
        const file = e.target.files[0];
        if(file) {
            pendingPlaylistImageFile = file;
            const reader = new FileReader();
            reader.onload = (ev) => { document.getElementById('editPlaylistPreview').src = ev.target.result; };
            reader.readAsDataURL(file);
        }
    }
    async function savePlaylistEdit() {
        const id = document.getElementById('editPlaylistId').value;
        const newName = document.getElementById('editPlaylistName').value.trim();
        const privacy = document.getElementById('editPlaylistPrivacy').value;
        
        const btn = document.getElementById('savePlaylistEditBtn');
        btn.innerText = "Salvando..."; btn.disabled = true;

        if(newName) {
            const pl = appState.playlists.find(p => p.id === id);
            if(pl) { 
                pl.name = newName; 
                pl.isPublic = privacy === 'public';
                
                if(pendingPlaylistImageFile) {
                    const url = await uploadToImgBB(pendingPlaylistImageFile);
                    if(url) pl.cover = url;
                }

                saveData(); 
                renderPlaylist(id); 
                showToast("Playlist atualizada"); 
            }
        }
        btn.innerText = "Salvar"; btn.disabled = false;
        closeEditPlaylistModal();
    }

    function deleteCurrentEditPlaylist() {
        const id = document.getElementById('editPlaylistId').value;
        if(confirm("Tem certeza que deseja excluir esta playlist?")) {
            appState.playlists = appState.playlists.filter(p => p.id !== id);
            saveData();
            closeEditPlaylistModal();
            showToast("Playlist excluída com sucesso.");
            navigateTo('library');
        }
    }

    function openImportModal() {
        if(!checkAuth('importar músicas')) return;
        document.getElementById('importLinkModal').classList.remove('hidden');
        const select = document.getElementById('importPlaylistSelect'); select.innerHTML = '';
        appState.playlists.filter(p => p.type === 'user').forEach(pl => { select.innerHTML += `<option value="${pl.id}">${pl.name}</option>`; });
        
        document.getElementById('importLinkInput').value = '';
        document.getElementById('csvFileName').classList.add('hidden');
        document.getElementById('csvFileName').innerText = '';
        document.getElementById('importCsvInput').value = '';
        csvDataToImport = [];

        setTimeout(() => { document.getElementById('importLinkModal').classList.remove('opacity-0'); document.getElementById('importLinkContent').classList.remove('scale-95'); document.getElementById('importLinkInput').focus(); }, 10);
    }

    function closeImportModal() {
        document.getElementById('importLinkModal').classList.add('opacity-0'); document.getElementById('importLinkContent').classList.add('scale-95');
        setTimeout(() => { document.getElementById('importLinkModal').classList.add('hidden'); document.getElementById('importLinkInput').value = ''; }, 200);
    }

    // --- NOVA LÓGICA DE IMPORTAÇÃO (LINK + CSV SPOTIFY) ---
    let csvDataToImport = [];

    function handleCsvFileSelect(e) {
        const file = e.target.files[0];
        if(!file) return;
        
        const label = document.getElementById('csvFileName');
        label.innerText = file.name;
        label.classList.remove('hidden');

        const reader = new FileReader();
        reader.onload = function(evt) {
            const text = evt.target.result;
            // Parse simples de CSV (Nome da música, Artista, etc)
            const lines = text.split('\n');
            csvDataToImport = [];
            // Ignorar cabeçalho e pegar dados
            for(let i = 1; i < lines.length; i++) {
                if(!lines[i].trim()) continue;
                // Dividir considerando vírgulas dentro de aspas
                const cols = lines[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
                if(cols.length >= 2) {
                    const trackName = cols[0].replace(/"/g, '').trim();
                    const artistName = cols[1].replace(/"/g, '').trim();
                    if(trackName && artistName) {
                        csvDataToImport.push(`${trackName} ${artistName} audio oficial`);
                    }
                }
            }
            if(csvDataToImport.length > 0) showToast(`${csvDataToImport.length} músicas lidas do CSV prontas para importar.`);
        };
        reader.readAsText(file);
    }

    async function silentSearchFetch(query) {
        try {
            const res = await fetch('/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query }) });
            const data = await res.json();
            if(data.videos && data.videos.length > 0) return data.videos[0];
            return null;
        } catch(e) { return null; }
    }

    async function importMediaProcess() {
        const link = document.getElementById('importLinkInput').value.trim();
        const plId = document.getElementById('importPlaylistSelect').value;
        const pl = appState.playlists.find(p => p.id === plId);

        if(!pl) return showToast("Nenhuma playlist de destino selecionada.");

        if(csvDataToImport.length > 0) {
            // Processo de Lote (Batch CSV)
            closeImportModal();
            showToast(`Importando ${csvDataToImport.length} músicas. Isso pode levar alguns minutos...`);
            
            let successCount = 0;
            for(let i = 0; i < csvDataToImport.length; i++) {
                const query = csvDataToImport[i];
                const v = await silentSearchFetch(query);
                if(v) {
                    const track = { id: v.url, title: v.title, artist: v.artist || v.author?.name || 'Desconhecido', cover: v.thumbnail || DEFAULT_COVER, url: v.url, duration: v.duration };
                    if(!pl.tracks.some(t => t.id === track.id)) {
                        pl.tracks.push(track);
                        successCount++;
                    }
                }
                // Pequeno delay para não sobrecarregar API
                await new Promise(r => setTimeout(r, 1000));
            }
            saveData();
            showToast(`Concluído! ${successCount} músicas importadas via CSV.`);
            if(currentView === 'playlist' && appState.queueContext === plId) renderPlaylist(plId);
            return;
        }

        // Processo Link (Antigo Intacto)
        if(!link) return showToast("Insira um link ou selecione um CSV");
        closeImportModal(); showToast("Buscando música/playlist e importando...");

        try {
            const response = await fetch('/search', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: link })
            });
            const data = await response.json();
            
            if(data.isPlaylist && data.videos && data.videos.length > 0) {
                const newPl = {
                    id: 'yt_' + Date.now(), 
                    name: data.playlistTitle || "Playlist Importada", 
                    type: 'youtube', 
                    owner: data.playlistAuthor || 'YouTube',
                    isPublic: false,
                    cover: data.videos[0].thumbnail || DEFAULT_COVER,
                    tracks: data.videos.map(v => ({ id: v.url, title: v.title, artist: v.artist || 'Desconhecido', cover: v.thumbnail || DEFAULT_COVER, url: v.url, duration: v.duration }))
                };
                appState.playlists.push(newPl); saveData(); showToast(`Playlist "${newPl.name}" salva!`); navigateTo('playlist', newPl.id); return;
            }
            
            if(data.videos && data.videos.length > 0) {
                const v = data.videos[0];
                const track = { id: v.url, title: v.title, artist: v.artist || v.author?.name || 'Desconhecido', cover: v.thumbnail || DEFAULT_COVER, url: v.url, duration: v.duration };
                if(!pl.tracks.some(t => t.id === track.id)) { pl.tracks.push(track); saveData(); showToast(`"${track.title}" adicionada com sucesso!`); if(currentView === 'playlist' && appState.queueContext === plId) renderPlaylist(plId); } 
                else showToast("Música já existia na playlist.");
            } else showToast("Música não encontrada através do link.");
        } catch(e) {
            showToast("Erro/Mock: Música importada com sucesso!");
            const track = { id: link, title: 'Música Importada (Offline)', artist: 'Desconhecido', cover: 'https://placehold.co/120x120/1ed760/000?text=Import', url: link, duration: "0:00" };
            pl.tracks.push(track); saveData(); if(currentView === 'playlist' && appState.queueContext === plId) renderPlaylist(plId);
        }
    }

    function showToast(msg) {
        const t = document.getElementById('toast'); t.innerText = msg; t.classList.remove('translate-y-10', 'opacity-0');
        setTimeout(() => t.classList.add('translate-y-10', 'opacity-0'), 3000);
    }
    
    // --- GOOGLE CAST (100% INTACTO) ---
    let castSession = null; let remotePlayer = null; let remotePlayerController = null;

    window['__onGCastApiAvailable'] = function(isAvailable) {
        if (isAvailable) initializeCastApi();
        else if (!window.chrome || !window.chrome.cast) console.log("Cast não suportado nativamente pelo seu navegador.");
    };

    function initializeCastApi() {
        cast.framework.CastContext.getInstance().setOptions({
            receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
        });
        remotePlayer = new cast.framework.RemotePlayer(); remotePlayerController = new cast.framework.RemotePlayerController(remotePlayer);

        remotePlayerController.addEventListener(cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED, function() {
            playerState.isCasting = remotePlayer.isConnected;
            if (playerState.isCasting) {
                showToast("Conectado ao dispositivo Cast"); dom.audio.pause();
                castSession = cast.framework.CastContext.getInstance().getCurrentSession();
                if (appState.currentTrackIndex > -1) castMedia(appState.queue[appState.currentTrackIndex]);
            } else { showToast("Desconectado do Cast"); castSession = null; if(playerState.isPlaying) dom.audio.play(); }
        });

        remotePlayerController.addEventListener(cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED, function() {
            if (playerState.isCasting && !isSeeking) {
                const t = remotePlayer.currentTime; const d = remotePlayer.duration;
                if(d) {
                    const pct = (t / d) * 100;
                    dom.progressSlider.value = pct; dom.fsProgressSlider.value = pct; updateProgressUI(pct);
                    dom.timeCurrent.innerText = formatTime(t); dom.timeTotal.innerText = formatTime(d); dom.fsTimeCurrent.innerText = formatTime(t); dom.fsTimeTotal.innerText = formatTime(d);
                    playerState.duration = d; 
                }
            }
        });

        remotePlayerController.addEventListener(cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED, function() {
            if (playerState.isCasting) {
                playerState.isPlaying = !remotePlayer.isPaused;
                const pClasses = playerState.isPlaying ? 'ph-fill ph-pause translate-x-[0px]' : 'ph-fill ph-play translate-x-[1px]';
                dom.iconPlayPause.className = `${pClasses} text-lg`;
                dom.mobileIconPlay.className = `${pClasses} text-[22px]`;
                dom.fsIconPlayPause.className = `${playerState.isPlaying ? 'ph-fill ph-pause translate-x-[0px]' : 'ph-fill ph-play translate-x-[2px]'} text-[28px]`;
            }
        });
    }

    async function castMedia(track) {
        if (!castSession) return;
        dom.loadingOverlays.forEach(el => el.classList.remove('hidden'));
        let audioUrlToCast = "";
        try {
            const res = await fetch('/get-audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: track.url }) });
            const data = await res.json();
            if(data.audioUrl) audioUrlToCast = data.audioUrl; else throw new Error("No URL");
        } catch(e) { audioUrlToCast = "https://actions.google.com/sounds/v1/alarms/digital_watch_alarm_long.ogg"; }

        var mediaInfo = new chrome.cast.media.MediaInfo(audioUrlToCast, 'audio/mp4');
        var metadata = new chrome.cast.media.MusicTrackMediaMetadata();
        metadata.metadataType = chrome.cast.media.MetadataType.MUSIC_TRACK; metadata.title = track.title; metadata.artist = track.artist;
        if(track.cover) metadata.images = [new chrome.cast.Image(track.cover)];
        mediaInfo.metadata = metadata;
        
        var request = new chrome.cast.media.LoadRequest(mediaInfo);
        castSession.loadMedia(request).then(
            function() { console.log('Cast started'); dom.loadingOverlays.forEach(el => el.classList.add('hidden')); },
            function(errorCode) { console.error('Cast Error:', errorCode); showToast("Erro no Cast"); dom.loadingOverlays.forEach(el => el.classList.add('hidden')); }
        );
    }

    // =========================================================================
    // NOVA FUNÇÃO: ATALHOS DE TECLADO (estilo Spotify Desktop)
    // Espaço = play/pause · ← → = anterior/próxima · ↑ ↓ = volume
    // M = mudo · S = aleatório · R = repetir · L = curtir · ? = mostrar atalhos
    // =========================================================================
    function isTypingContext(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    function openShortcutsModal() {
        const modal = document.getElementById('shortcutsModal');
        if (!modal) return;
        modal.classList.remove('hidden');
        setTimeout(() => {
            modal.classList.remove('opacity-0');
            document.getElementById('shortcutsContent').classList.remove('scale-95');
        }, 10);
    }
    function closeShortcutsModal() {
        const modal = document.getElementById('shortcutsModal');
        if (!modal) return;
        modal.classList.add('opacity-0');
        document.getElementById('shortcutsContent').classList.add('scale-95');
        setTimeout(() => modal.classList.add('hidden'), 200);
    }

    function initKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Não interfere enquanto o usuário digita em campos de texto
            if (isTypingContext(document.activeElement)) return;
            // Não interfere se algum modal de formulário estiver aberto (evita conflito com Enter/Escape deles)
            if (document.body.classList.contains('modal-open') && e.key !== '?' && e.key !== 'Escape') return;

            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    togglePlayPause();
                    break;
                case 'ArrowRight':
                    if (e.shiftKey || e.altKey) { e.preventDefault(); playNext(); }
                    break;
                case 'ArrowLeft':
                    if (e.shiftKey || e.altKey) { e.preventDefault(); playPrev(); }
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    applyVolume(Math.min(1, (playerState.volume || 0) + 0.1));
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    applyVolume(Math.max(0, (playerState.volume || 0) - 0.1));
                    break;
                case 'm': case 'M':
                    toggleMute();
                    break;
                case 's': case 'S':
                    toggleShuffle();
                    break;
                case 'r': case 'R':
                    toggleRepeat();
                    break;
                case 'l': case 'L':
                    if (appState.currentTrackIndex > -1) toggleLikeCurrent();
                    break;
                case '?':
                    openShortcutsModal();
                    break;
                case 'Escape':
                    closeShortcutsModal();
                    break;
            }
        });
    }

    // INIT UI
    applyVolume(1);
    dom.progressSlider.style.background = `linear-gradient(to right, #fff 0%, #4d4d4d 0%)`;
    dom.fsProgressSlider.style.background = `linear-gradient(to right, #fff 0%, #4d4d4d 0%)`;
    
    if (window.innerWidth >= 768) {
        isRightSidebarOpen = true;
        document.getElementById('rightSidebar').style.display = 'flex';
        document.getElementById('rightSidebarIcon').classList.add('text-spotify-green');
    }

    auth.onAuthStateChanged(async (user) => { if (!currentUser) await loadData(); });
    navigateTo('home');
    initKeyboardShortcuts();
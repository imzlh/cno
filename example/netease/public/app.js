// ─── State ───────────────────────────────────────────────────────────────────
let searchResults = [];
let selectedIds = [];
let queuePoll = null;

// ─── Toast ───────────────────────────────────────────────────────────────────
function toast(msg) {
    const el = document.getElementById('snackbar');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
}

// ─── Tabs ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
});

// ─── Escaper ─────────────────────────────────────────────────────────────────
function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function fmtDur(ms) {
    if (!ms) return '';
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ─── API helpers ─────────────────────────────────────────────────────────────
async function apiGet(path, params) {
    const sp = new URLSearchParams();
    if (params) Object.entries(params).forEach(([k, v]) => { if (v != null) sp.set(k, String(v)); });
    const res = await fetch(`/api${path}?${sp}`);
    return res.json();
}

// ─── Cookie / Login ──────────────────────────────────────────────────────────
async function setCookie() {
    const val = document.getElementById('cookieInput').value.trim();
    if (!val) return toast('请输入 Cookie');
    try {
        const r = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie: val }),
        });
        const d = await r.json();
        if (d.logged) { toast('登录成功: ' + d.nickname); checkLogin(); }
        else toast('登录失败: ' + (d.error || 'Cookie 可能无效'));
    } catch (e) { toast('错误: ' + e.message); }
}

async function checkLogin() {
    try {
        const d = await apiGet('/login-status');
        const el = document.getElementById('loginStatus');
        if (d?.logged && d?.nickname) {
            el.innerHTML = `<span class="chip chip-success">✓ ${esc(d.nickname)}</span>`;
        } else {
            el.innerHTML = '<span class="chip chip-error">未登录</span>';
        }
    } catch { document.getElementById('loginStatus').innerHTML = '<span class="chip chip-error">无法连接</span>'; }
}

// ─── Search ──────────────────────────────────────────────────────────────────
async function doSearch() {
    const kw = document.getElementById('searchInput').value.trim();
    const type = document.getElementById('searchType').value;
    if (!kw) return toast('请输入关键词');

    const el = document.getElementById('searchResults');
    el.innerHTML = '<div class="empty-state"><p>搜索中...</p></div>';

    try {
        const d = await apiGet('/search', { keywords: kw, type, limit: 30 });
        // search returns { result: { songs: [...], artists: [...], albums: [...], playlists: [...] } }
        const result = d?.result || d?.data?.result || {};
        let items = [];

        if (type === '1') {
            items = result.songs || [];
            searchResults = items;
            selectedIds = [];
            if (!items.length) return (el.innerHTML = '<div class="empty-state"><div class="icon">🎵</div><p>未找到歌曲</p></div>');
            renderSongResults(items);
        } else if (type === '100') {
            items = result.artists || [];
            if (!items.length) return (el.innerHTML = '<div class="empty-state"><div class="icon">🎤</div><p>未找到歌手</p></div>');
            renderArtistResults(items);
        } else if (type === '10') {
            items = result.albums || [];
            if (!items.length) return (el.innerHTML = '<div class="empty-state"><div class="icon">💿</div><p>未找到专辑</p></div>');
            renderAlbumResults(items);
        } else if (type === '1000') {
            items = result.playlists || [];
            if (!items.length) return (el.innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>未找到歌单</p></div>');
            renderPlaylistResults(items);
        }
    } catch (e) {
        el.innerHTML = `<div class="empty-state"><p>搜索失败: ${esc(e.message)}</p></div>`;
    }
}

function renderSongResults(songs) {
    const el = document.getElementById('searchResults');
    el.innerHTML = songs.map((s, i) => {
        const artists = (s.artists || s.ar || []).map(a => esc(a.name)).join(', ');
        const album = s.album?.name || s.al?.name || '';
        const dur = fmtDur(s.duration || s.dt);
        return `<div class="list-item" data-id="${s.id}" onclick="toggleSelect(this,${s.id})">
            <div class="info">
                <div class="name">${i + 1}. ${esc(s.name)}</div>
                <div class="meta">${artists} · ${esc(album)} · ${dur}</div>
            </div>
            <div class="actions">
                <button class="btn btn-text btn-icon" onclick="event.stopPropagation();downloadSongs([${s.id}])" title="下载">⬇️</button>
            </div>
        </div>`;
    }).join('');
}

function renderArtistResults(artists) {
    const el = document.getElementById('searchResults');
    el.innerHTML = `<div class="artists-grid">` + artists.map(a => `
        <div class="artist-card" onclick="showArtistActions(${a.id},'${esc(a.name)}')">
            <img class="avatar" src="${a.picUrl || ''}" alt="" loading="lazy" onerror="this.style.background='var(--surface-container-highest)'">
            <div class="name">${esc(a.name)}</div>
            <div class="count">ID: ${a.id}</div>
        </div>
    `).join('') + `</div>`;
}

function renderAlbumResults(albums) {
    const el = document.getElementById('searchResults');
    el.innerHTML = `<div class="albums-grid">` + albums.map(a => {
        const artistName = (a.artist?.name || (a.artists || []).map(x => x.name).join(', '));
        return `<div class="album-card" onclick="downloadAlbum(${a.id})">
            <img class="cover" src="${a.picUrl || ''}" alt="" loading="lazy" onerror="this.style.background='var(--surface-container-highest)'">
            <div class="name">${esc(a.name)}</div>
            <div class="meta">${esc(artistName)} · ${a.size || 0}首</div>
        </div>`;
    }).join('') + `</div>`;
}

function renderPlaylistResults(playlists) {
    const el = document.getElementById('searchResults');
    el.innerHTML = playlists.map(p => `
        <div class="list-item" onclick="downloadPlaylist(${p.id})">
            <img class="thumb" src="${p.coverImgUrl || ''}" alt="" loading="lazy" onerror="this.style.background='var(--surface-container-highest)'">
            <div class="info">
                <div class="name">${esc(p.name)}</div>
                <div class="meta">by ${esc(p.creator?.nickname || '')} · ${p.trackCount || 0}首 · ${p.playCount || 0}播放</div>
            </div>
            <div class="actions"><button class="btn btn-text btn-icon" title="下载">⬇️</button></div>
        </div>
    `).join('');
}

// ─── Selection ───────────────────────────────────────────────────────────────
function toggleSelect(el, id) {
    el.classList.toggle('selected');
    if (selectedIds.includes(id)) selectedIds = selectedIds.filter(x => x !== id);
    else selectedIds.push(id);
}

function selectAllSongs() {
    document.querySelectorAll('#searchResults .list-item[data-id]').forEach(el => {
        el.classList.add('selected');
    });
    selectedIds = searchResults.map(s => s.id);
}

// ─── Download actions ────────────────────────────────────────────────────────
async function downloadSongs(ids) {
    if (!ids?.length) return toast('请先选择歌曲');
    const opts = getOpts();
    try {
        const r = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ songs: ids.map(id => ({ id })), options: opts }),
        });
        const d = await r.json();
        if (d.error) toast('失败: ' + d.error);
        else { toast(d.message); refreshQueue(); }
    } catch (e) { toast('错误: ' + e.message); }
}

async function downloadPlaylist(id) {
    try {
        const d = await apiGet('/playlist', { id });
        const p = d?.playlist || d?.data?.playlist;
        if (!p) return toast('无法获取歌单信息');
        const ids = (p.trackIds || []).map(t => typeof t === 'number' ? t : t.id);
        if (!ids.length) return toast('歌单为空');
        // Fetch song details in batches
        const songs = [];
        for (let i = 0; i < ids.length; i += 50) {
            const batch = ids.slice(i, i + 50);
            const sd = await apiGet('/songs', { ids: batch.join(',') });
            const list = sd?.songs || sd?.data?.songs || [];
            songs.push(...list);
        }
        await downloadSongs(songs.map(s => s.id));
    } catch (e) { toast('错误: ' + e.message); }
}

async function downloadAlbum(id) {
    try {
        const d = await apiGet('/album', { id });
        const songs = d?.songs || d?.data?.songs || [];
        if (!songs.length) return toast('专辑为空');
        await downloadSongs(songs.map(s => s.id));
    } catch (e) { toast('错误: ' + e.message); }
}

// ─── Artist actions ──────────────────────────────────────────────────────────
async function showArtistActions(id, name) {
    const action = prompt(`[${name}]\n1=热门50首  2=全部专辑  3=选择专辑`, '1');
    if (action === '1') artistTop50(id);
    else if (action === '2') artistAllAlbums(id);
    else if (action === '3') showArtistAlbumPicker(id);
}

async function artistTop50(id) {
    try {
        const d = await apiGet('/artist-top', { id });
        const songs = d?.hotSongs || d?.data?.hotSongs || [];
        if (!songs.length) return toast('无热门歌曲');
        await downloadSongs(songs.map(s => s.id));
    } catch (e) { toast('错误: ' + e.message); }
}

async function artistAllAlbums(id) {
    try {
        const d = await apiGet('/artist-albums', { id });
        const albums = d?.hotAlbums || d?.data?.hotAlbums || [];
        if (!albums.length) return toast('无专辑');
        for (const album of albums) {
            const ad = await apiGet('/album', { id: album.id });
            const songs = ad?.songs || ad?.data?.songs || [];
            if (songs.length) await downloadSongs(songs.map(s => s.id));
        }
        toast('全部专辑下载完成');
    } catch (e) { toast('错误: ' + e.message); }
}

async function showArtistAlbumPicker(id) {
    try {
        const d = await apiGet('/artist-albums', { id });
        const albums = d?.hotAlbums || d?.data?.hotAlbums || [];
        if (!albums.length) return toast('无专辑');
        const area = document.getElementById('artistAlbumsArea');
        area.innerHTML = `<div class="albums-grid">` + albums.map(a => `
            <div class="album-card" onclick="downloadAlbum(${a.id})">
                <img class="cover" src="${a.picUrl || ''}" alt="" loading="lazy" onerror="this.style.background='var(--surface-container-highest)'">
                <div class="name">${esc(a.name)}</div>
                <div class="meta">${a.size || 0}首</div>
            </div>
        `).join('') + `</div>`;
    } catch (e) { toast('错误: ' + e.message); }
}

// ─── Quick download ──────────────────────────────────────────────────────────
async function quickDownload(type) {
    const val = document.getElementById('quickIds').value.trim();
    if (!val) return toast('请输入 ID');
    const ids = val.split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return toast('无有效 ID');

    if (type === 'song') await downloadSongs(ids.map(Number));
    else if (type === 'playlist') {
        for (const id of ids) await downloadPlaylist(Number(id));
    } else if (type === 'album') {
        for (const id of ids) await downloadAlbum(Number(id));
    }
}

// ─── Queue ───────────────────────────────────────────────────────────────────
async function refreshQueue() {
    try {
        const d = await apiGet('/tasks');
        const tasks = d?.data || d?.tasks || [];
        const el = document.getElementById('queueList');
        document.getElementById('queueCount').textContent = tasks.length;

        if (!tasks.length) {
            el.innerHTML = '<div class="empty-state"><div class="icon">📭</div><p>暂无下载任务</p></div>';
            return;
        }
        el.innerHTML = tasks.slice().reverse().map(t => `
            <div class="queue-item">
                <div class="status-dot ${t.status}"></div>
                <div class="song-name">${esc(t.songName)}</div>
                <div class="song-status">${t.error ? esc(t.error) : t.status}</div>
            </div>
        `).join('');
    } catch { /* ignore */ }
}

// ─── Settings ────────────────────────────────────────────────────────────────
function getOpts() {
    return {
        quality: document.getElementById('cfgQuality').value,
        format: document.getElementById('cfgFormat').value,
        concurrency: parseInt(document.getElementById('cfgConcurrency').value),
        outputDir: document.getElementById('cfgOutputDir').value,
        embedCover: document.getElementById('cfgCover').checked,
        embedLyric: document.getElementById('cfgLyric').checked,
    };
}

async function loadConfig() {
    try {
        const d = await apiGet('/config');
        const cfg = d?.data || d || {};

        const qSel = document.getElementById('cfgQuality');
        (cfg.qualities || []).forEach(q => {
            const o = document.createElement('option');
            o.value = q.level; o.textContent = q.name;
            qSel.appendChild(o);
        });

        const fSel = document.getElementById('cfgFormat');
        (cfg.formats || []).forEach(f => {
            const o = document.createElement('option');
            o.value = f.format; o.textContent = `${f.name} — ${f.desc}`;
            fSel.appendChild(o);
        });
    } catch { /* ignore */ }
}

// ─── Init ────────────────────────────────────────────────────────────────────
checkLogin();
loadConfig();
refreshQueue();
queuePoll = setInterval(refreshQueue, 3000);

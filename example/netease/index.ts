import { ensureDir } from "jsr:@std/fs@^1.0.10/ensure-dir";
import { api, DownloadEngine, DownloadOptions, setCookie, log, colors, showStats, removeIllegalPath, normalizeDir, formatDuration } from "./lib.ts";
import { AUDIO_QUALITIES, OUTPUT_FORMATS } from "./types.ts";
import type { ISongDetail } from "./api/types.ts";

const defaultOpts: DownloadOptions = {
    outputDir: "musicout/", format: "mp3", quality: "standard",
    embedCover: true, embedLyric: true, concurrency: 1,
};

export default async function main() {
    let opts = { ...defaultOpts };
    log.info(`输出目录: ${opts.outputDir}`);
    try {
        setCookie(await Deno.readTextFile("netease.cookie"));
        const d = await api.getLoginStatus();
        if (d?.data?.profile) log.success(`已登录: ${d.data.profile.nickname}`);
        else log.warning("Cookie 可能已过期");
    } catch { log.info("未登录"); }

    await ensureDir(opts.outputDir);
    const engine = new DownloadEngine(opts);

    while (true) {
        showMenu(opts);
        const choice = prompt("请选择: ");
        if (!choice) continue;
        const c = choice.trim().toLowerCase();
        if (c === "q") { log.info("再见！"); Deno.exit(0); }
        try {
            switch (c) {
                case "0": await handleLogin(); break;
                case "1": await handleSettings(engine); break;
                case "2": await handleSearchSong(engine); break;
                case "3": await handleSearchArtist(engine); break;
                case "4": await handleDownloadById(engine); break;
                case "5": await handleDownloadPlaylist(engine); break;
                case "6": await handleDownloadAlbum(engine); break;
                case "7": await handleBatchIds(engine); break;
                default: log.warning("无效选项");
            }
        } catch (e) { log.error(`操作失败: ${(e as Error).message}`); }
        prompt("\n按回车继续...");
    }
}

function showMenu(opts: DownloadOptions) {
    const qn = AUDIO_QUALITIES.find(q => q.level === opts.quality)?.name ?? opts.quality;
    const fn = OUTPUT_FORMATS.find(f => f.format === opts.format)?.name ?? opts.format;
    console.log(`\n${"═".repeat(50)}\n  🎵 网易云音乐下载器\n${"═".repeat(50)}`);
    console.log(`  0.登录  1.设置[音质:${qn}|格式:${fn}|并发:${opts.concurrency}]`);
    console.log(`  2.搜索歌曲  3.搜索歌手  4.下载单曲`);
    console.log(`  5.下载歌单  6.下载专辑  7.批量下载  q.退出`);
    console.log("═".repeat(50));
}

async function handleLogin() {
    const c = prompt("Cookie: ");
    if (!c?.trim()) return;
    setCookie(c.trim());
    await Deno.writeTextFile("netease.cookie", c.trim());
    const d = await api.getLoginStatus();
    if (d?.data?.profile) log.success(`登录成功: ${d.data.profile.nickname}`);
    else log.warning("Cookie 可能无效");
}

async function handleSettings(engine: DownloadEngine) {
    const opts = engine.getOpts();
    console.log(`\n当前: 音质=${opts.quality} 格式=${opts.format} 并发=${opts.concurrency}`);
    console.log("1.音质 2.格式 3.封面 4.歌词 5.并发 6.目录");
    switch (prompt("选择: ")?.trim()) {
        case "1":
            AUDIO_QUALITIES.forEach((q, i) => console.log(`  ${i + 1}. ${q.name}`));
            { const idx = parseInt(prompt("选择: ") || "1") - 1;
              if (idx >= 0 && idx < AUDIO_QUALITIES.length) engine.updateOpts({ quality: AUDIO_QUALITIES[idx].level }); }
            break;
        case "2":
            OUTPUT_FORMATS.forEach((f, i) => console.log(`  ${i + 1}. ${f.name} - ${f.desc}`));
            { const idx = parseInt(prompt("选择: ") || "1") - 1;
              if (idx >= 0 && idx < OUTPUT_FORMATS.length) engine.updateOpts({ format: OUTPUT_FORMATS[idx].format }); }
            break;
        case "3": engine.updateOpts({ embedCover: !opts.embedCover }); break;
        case "4": engine.updateOpts({ embedLyric: !opts.embedLyric }); break;
        case "5": { const n = parseInt(prompt("并发数(1-8): ") || "1");
              if (n >= 1 && n <= 8) engine.updateOpts({ concurrency: n }); } break;
        case "6": { const dir = prompt(`目录 [${opts.outputDir}]: `) || opts.outputDir;
              await ensureDir(dir); engine.updateOpts({ outputDir: dir }); } break;
    }
    log.success("设置已更新");
}

async function handleSearchSong(engine: DownloadEngine) {
    while (true) {
        const kw = prompt("\n歌曲名称 (回车退出): ");
        if (!kw) break;
        const d = await api.search(kw, 1, 20);
        const songs: any[] = d?.result?.songs || [];
        if (!songs.length) { log.warning("未找到"); break; }
        songs.forEach((s, i) => {
            const ar = (s.ar || s.artists || []).map((a: any) => a.name).join(', ');
            console.log(`  ${i + 1}. ${s.name} - ${ar} [${formatDuration(s.dt || s.duration)}]`);
        });
        const sel = prompt("选择 (逗号分隔, all=全部): ");
        if (!sel) continue;
        const ids = sel === 'all' ? songs.map(s => s.id)
            : sel.split(',').map(s => parseInt(s.trim()) - 1).filter((i: number) => i >= 0 && i < songs.length).map((i: number) => songs[i].id);
        if (!ids.length) continue;
        const sd = await api.getSongDetail(ids);
        const fullSongs: ISongDetail[] = sd?.data?.songs || sd?.songs || [];
        const stats = await downloadList(engine, fullSongs);
        showStats("下载完成", stats);
    }
}

async function handleSearchArtist(engine: DownloadEngine) {
    while (true) {
        const kw = prompt("\n歌手名称 (回车退出): ");
        if (!kw) break;
        const d = await api.search(kw, 100, 10);
        const artists = d?.result?.artists || [];
        if (!artists.length) { log.warning("未找到"); break; }
        artists.forEach((a: any, i: number) => console.log(`  ${i + 1}. ${a.name} (ID:${a.id})`));
        const idx = parseInt(prompt("选择: ") || "0") - 1;
        if (idx < 0 || idx >= artists.length) break;
        const artist = artists[idx];
        console.log("1.热门50首 2.全部专辑 3.选择专辑");
        switch (prompt("选择: ")?.trim()) {
            case "1": {
                const td = await api.getArtistSongs(artist.id);
                const folder = normalizeDir(`${engine.getOpts().outputDir}歌手_${removeIllegalPath(artist.name)}_热门50首`);
                await ensureDir(folder);
                const stats = await downloadList(engine, (td?.data?.hotSongs || []) as ISongDetail[], folder);
                showStats(`${artist.name} - 热门50首`, stats, folder);
                break;
            }
            case "2": await downloadAllAlbums(engine, artist.id, artist.name); break;
            case "3": {
                const ad = await api.getArtistAlbums(artist.id);
                const albums = ad?.data?.hotAlbums || [];
                albums.forEach((a: any, i: number) => console.log(`  ${i + 1}. ${a.name} (${a.size || 0}首)`));
                const ai = parseInt(prompt("选择: ") || "0") - 1;
                if (ai >= 0 && ai < albums.length) {
                    const { songs, album } = await getAlbumSongs(albums[ai].id);
                    const folder = normalizeDir(`${engine.getOpts().outputDir}专辑_${removeIllegalPath(album.name)}`);
                    await ensureDir(folder);
                    const stats = await downloadList(engine, songs, folder);
                    showStats(album.name, stats, folder);
                }
                break;
            }
        }
    }
}

async function handleDownloadById(engine: DownloadEngine) {
    while (true) {
        const input = prompt("\n歌曲ID (回车退出): ");
        if (!input) break;
        const id = input.match(/\d+/)?.[0];
        if (!id) { log.error("无效ID"); continue; }
        const sd = await api.getSongDetail(Number(id));
        const songs: ISongDetail[] = sd?.data?.songs || [];
        if (songs.length > 0) await engine.downloadSong(songs[0]);
    }
}

async function handleDownloadPlaylist(engine: DownloadEngine) {
    while (true) {
        const input = prompt("\n歌单ID (回车退出): ");
        if (!input) break;
        const id = Number(input.match(/\d+/)?.[0]);
        if (!id) break;
        const d = await api.getPlaylistDetail(id);
        const p = d?.data?.playlist || d?.playlist;
        if (!p) { log.error("无法获取歌单"); break; }
        const ids = (p.trackIds || []).map((t: any) => typeof t === 'number' ? t : t.id);
        const allSongs: ISongDetail[] = [];
        for (let i = 0; i < ids.length; i += 50) {
            const sd = await api.getSongDetail(ids.slice(i, i + 50));
            allSongs.push(...(sd?.data?.songs || []));
        }
        const folder = normalizeDir(`${engine.getOpts().outputDir}歌单_${removeIllegalPath(p.name)}`);
        await ensureDir(folder);
        const stats = await downloadList(engine, allSongs, folder);
        showStats(p.name, stats, folder);
    }
}

async function handleDownloadAlbum(engine: DownloadEngine) {
    while (true) {
        const input = prompt("\n专辑ID (回车退出): ");
        if (!input) break;
        const id = Number(input.match(/\d+/)?.[0]);
        if (!id) break;
        const { songs, album } = await getAlbumSongs(id);
        const folder = normalizeDir(`${engine.getOpts().outputDir}专辑_${removeIllegalPath(album.name)}`);
        await ensureDir(folder);
        const stats = await downloadList(engine, songs, folder);
        showStats(album.name, stats, folder);
    }
}

async function handleBatchIds(engine: DownloadEngine) {
    const input = prompt("\n多个歌曲ID (逗号分隔): ");
    if (!input) return;
    const ids = input.split(',').map(s => s.trim()).filter(Boolean).map(Number);
    if (!ids.length) return;
    const sd = await api.getSongDetail(ids);
    const songs: ISongDetail[] = sd?.data?.songs || [];
    const stats = await downloadList(engine, songs);
    showStats("批量下载完成", stats);
}

async function getAlbumSongs(id: number) {
    const d = await api.getAlbum(id);
    const data = d?.data || d;
    return { songs: (data?.songs || []) as ISongDetail[], album: (data?.album || {}) };
}

async function downloadAllAlbums(engine: DownloadEngine, artistId: number, artistName: string) {
    const ad = await api.getArtistAlbums(artistId);
    const albums = ad?.data?.hotAlbums || [];
    log.info(`${artistName}: ${albums.length} 张专辑`);
    const total = { total: 0, success: 0, failed: 0 };
    const folder = normalizeDir(`${engine.getOpts().outputDir}歌手_${removeIllegalPath(artistName)}_全部专辑`);
    await ensureDir(folder);
    for (const album of albums) {
        const { songs } = await getAlbumSongs(album.id);
        const stats = await downloadList(engine, songs, folder);
        total.total += stats.total; total.success += stats.success; total.failed += stats.failed;
    }
    showStats(`${artistName} - 全部专辑`, total);
}

async function downloadList(engine: DownloadEngine, songs: ISongDetail[], folder?: string) {
    const stats = { total: songs.length, success: 0, failed: 0 };
    for (let i = 0; i < songs.length; i++) {
        console.log(`${colors.dim}[${i + 1}/${songs.length}]${colors.reset}`);
        if (await engine.downloadSong(songs[i], folder)) stats.success++; else stats.failed++;
    }
    return stats;
}

if (import.meta.main) main();

/**
 * Web UI for Netease Music Downloader
 * Run: deno run -A webui.ts
 * Open: http://localhost:8080
 */

import { serveDir } from "jsr:@std/http@^1.0.23/file-server";
import { DownloadEngine, setCookie } from "./lib.ts";
import type { ISongDetail } from "./lib.ts";
import { api } from "./lib.ts";
import { AUDIO_QUALITIES, OUTPUT_FORMATS } from "./types.ts";

const PORT = parseInt(Deno.env.get("PORT") || "8080");

interface Task {
    id: string;
    songName: string;
    status: string;
    error?: string;
}
const tasks: Task[] = [];

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // ── Static files ──────────────────────────────────────────────────────
    if (!p.startsWith("/api/")) {
        return serveDir(req, { fsRoot: "public", quiet: true });
    }

    // ── Login ─────────────────────────────────────────────────────────────
    if (p === "/api/login" && req.method === "POST") {
        try {
            const body = await req.json();
            const cookie = body.cookie || "";
            setCookie(cookie);
            await Deno.writeTextFile("netease.cookie", cookie);
        } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    if (p === "/api/login-status" || p === "/api/login") {
        try {
            const d = await api.getLoginStatus() as { code?: number; data?: { profile?: { nickname?: string }; account?: unknown } | null };
            const profile = d?.data?.profile;
            return json({ logged: !!profile, nickname: profile?.nickname || "", code: d?.code });
        } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // ── Search ────────────────────────────────────────────────────────────
    if (p === "/api/search") {
        const kw = url.searchParams.get("keywords") || "";
        const type = Number(url.searchParams.get("type") || "1");
        const limit = Number(url.searchParams.get("limit") || "30");
        if (!kw) return json({ error: "请输入关键词" }, 400);
        try {
            const d = await api.search(kw, type, limit);
            return json(d);
        } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // ── Songs batch ───────────────────────────────────────────────────────
    if (p === "/api/songs") {
        const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
        if (!ids.length) return json({ songs: [] });
        try {
            const d = await api.getSongDetail(ids.map(Number));
            return json({ songs: d?.data?.songs || d?.songs || [] });
        } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // ── Playlist ──────────────────────────────────────────────────────────
    if (p === "/api/playlist") {
        const id = Number(url.searchParams.get("id"));
        if (!id) return json({ error: "请输入歌单 ID" }, 400);
        try {
            const d = await api.getPlaylistDetail(id);
            return json(d);
        } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // ── Album ─────────────────────────────────────────────────────────────
    if (p === "/api/album") {
        const id = Number(url.searchParams.get("id"));
        if (!id) return json({ error: "请输入专辑 ID" }, 400);
        try {
            const d = await api.getAlbum(id);
            return json(d);
        } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // ── Artist ────────────────────────────────────────────────────────────
    if (p === "/api/artist-albums") {
        const id = Number(url.searchParams.get("id"));
        if (!id) return json({ error: "请输入歌手 ID" }, 400);
        try {
            const d = await api.getArtistAlbums(id);
            return json(d);
        } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    if (p === "/api/artist-top") {
        const id = Number(url.searchParams.get("id"));
        if (!id) return json({ error: "请输入歌手 ID" }, 400);
        try {
            const d = await api.getArtistSongs(id);
            return json(d);
        } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // ── Download ──────────────────────────────────────────────────────────
    if (p === "/api/download" && req.method === "POST") {
        try {
            const body = await req.json();
            const songIds = (body.songs || []).map((s: { id: number }) => s.id);
            const options = body.options || {};
            if (!songIds.length) return json({ error: "未选择歌曲" }, 400);

            // Fetch full song details
            const sd = await api.getSongDetail(songIds);
            const songs: ISongDetail[] = sd?.data?.songs || sd?.songs || [];

            const taskIds: Task[] = songs.map(s => ({
                id: crypto.randomUUID(),
                songName: s.name,
                status: "pending",
            }));
            tasks.push(...taskIds);

            const engine = new DownloadEngine({
                outputDir: options.outputDir || "musicout/",
                format: options.format || "mp3",
                quality: options.quality || "standard",
                embedCover: options.embedCover !== false,
                embedLyric: options.embedLyric !== false,
                concurrency: options.concurrency || 1,
            });

            (async () => {
                for (let i = 0; i < songs.length; i++) {
                    taskIds[i].status = "downloading";
                    try {
                        await engine.downloadSong(songs[i]);
                        taskIds[i].status = "done";
                    } catch (e) {
                        taskIds[i].status = "error";
                        taskIds[i].error = (e as Error).message;
                    }
                }
            })();

            return json({ message: `已开始下载 ${songs.length} 首歌曲`, taskIds: taskIds.map(t => t.id) });
        } catch (e) { return json({ error: (e as Error).message }, 500); }
    }

    // ── Tasks ─────────────────────────────────────────────────────────────
    if (p === "/api/tasks") {
        return json({ data: tasks.slice(-100) });
    }

    // ── Config ────────────────────────────────────────────────────────────
    if (p === "/api/config") {
        return json({
            data: {
                qualities: AUDIO_QUALITIES,
                formats: OUTPUT_FORMATS,
            },
        });
    }

    return json({ error: "Not Found" }, 404);
}

console.log(`\x1b[32m🎵 Web UI 启动\x1b[0m  http://localhost:${PORT}`);
Deno.serve({ port: PORT }, handle);

import { ensureDir } from "jsr:@std/fs@^1.0.10/ensure-dir";
import * as api from "./api/index.ts";
import { setCookie, getCookie } from "./api/request.ts";
import type { ISong, ISongDetail, IAlbum, IArtist, IPlaylist } from "./api/types.ts";

// Re-export types for convenience
export type { ISong, ISongDetail, IAlbum, IArtist, IPlaylist };
export { api, setCookie, getCookie };

// ─── Logger (CLI) ────────────────────────────────────────────────────────────

export const colors = {
    reset: "\x1b[0m", bright: "\x1b[1m", dim: "\x1b[2m",
    green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
    blue: "\x1b[34m", cyan: "\x1b[36m", magenta: "\x1b[35m", white: "\x1b[37m",
};

export const log = {
    success: (msg: string) => console.log(`${colors.green}✓ ${msg}${colors.reset}`),
    error: (msg: string) => console.log(`${colors.red}✗ ${msg}${colors.reset}`),
    warning: (msg: string) => console.log(`${colors.yellow}⚠ ${msg}${colors.reset}`),
    info: (msg: string) => console.log(`${colors.cyan}ℹ ${msg}${colors.reset}`),
    title: (msg: string) => console.log(`${colors.bright}${colors.blue}${msg}${colors.reset}`),
    dim: (msg: string) => console.log(`${colors.dim}${msg}${colors.reset}`),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const removeIllegalPath = (path: string) =>
    path?.replaceAll(/[\/:*?"<>|]/gi, "_") ?? "";

export function formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function showProgress(current: number, total: number, songName: string) {
    const pct = Math.floor((current / total) * 100);
    const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
    const name = songName.length > 30 ? songName.slice(0, 27) + "..." : songName;
    process.stdout.write(`\r${colors.cyan}[${bar}] ${pct}%${colors.reset} ${colors.dim}-${colors.reset} ${name}`);
}

// ─── LRC merge ───────────────────────────────────────────────────────────────

export function mergeLrc(lrcA: string, lrcB: string): string {
    type Line = { t: number; raw: string };
    const parse = (raw: string): Line | null => {
        const m = raw.trim().match(/^(\[\d{2}:\d{2}\.\d{2,3}\])(.*)$/);
        if (!m) return null;
        const [, tag, text] = m;
        const min = +tag.slice(1, 3);
        const sec = +tag.slice(4, 6);
        const ms = +tag.slice(7, -1).padEnd(3, "0");
        return { t: min * 60_000 + sec * 1000 + ms, raw };
    };
    const lines: Line[] = [...lrcA.split("\n"), ...lrcB.split("\n")]
        .map(parse).filter((x): x is Line => x !== null);
    const seen = new Set<number>();
    return lines
        .filter((l) => { if (seen.has(l.t)) return false; seen.add(l.t); return true; })
        .sort((a, b) => a.t - b.t)
        .map((l) => l.raw).join("\n");
}

// ─── Audio source ────────────────────────────────────────────────────────────

export interface AudioSource {
    url: string; type: string; size: number; level: string; br: number;
}

const QUALITY_LEVELS = [
    "standard", "higher", "exhigh", "lossless", "hires", "jyeffect", "sky", "dolby", "jymaster",
];

export async function getAudioSource(id: number, quality: string): Promise<AudioSource | null> {
    const startIdx = QUALITY_LEVELS.indexOf(quality);
    const tryLevels = QUALITY_LEVELS.slice(startIdx);

    for (const level of tryLevels) {
        try {
            const data = await api.getSongUrlV1(id, level);
            if (data.data?.[0]?.url) {
                const item = data.data[0];
                return {
                    url: item.url,
                    type: item.type || level,
                    size: item.size || 0,
                    level,
                    br: item.br || 0,
                };
            }
        } catch { continue; }
    }
    return null;
}

// ─── Download Engine ─────────────────────────────────────────────────────────

export interface DownloadOptions {
    outputDir: string;
    format: string;
    quality: string;
    embedCover: boolean;
    embedLyric: boolean;
    concurrency: number;
}

export interface DownloadStats { total: number; success: number; failed: number; }

export class DownloadEngine {
    constructor(private opts: DownloadOptions) {}

    updateOpts(opts: Partial<DownloadOptions>) {
        Object.assign(this.opts, opts);
    }

    getOpts(): DownloadOptions {
        return { ...this.opts };
    }

    private getExtension(): string {
        const map: Record<string, string> = {
            mp3: ".mp3", flac: ".flac", wav: ".wav", opus: ".opus",
            aac: ".aac", m4a: ".m4a", copy: ".mp3",
        };
        return map[this.opts.format] || ".mp3";
    }

    private buildFFmpegArgs(input: string, output: string, song: ISongDetail, cover: string | null): string[] {
        const fmt = this.opts.format;
        const ar: IArtist[] = (song.ar as IArtist[]) || ((song as unknown as Record<string, unknown>).artists as IArtist[]) || [];
        const al = (song.al as IAlbum) || ((song as unknown as Record<string, unknown>).album as IAlbum);
        const meta = [
            "-metadata", `title=${song.name}`,
            "-metadata", `artist=${ar.map((a) => a.name).join(",")}`,
            "-metadata", `album=${al?.name ?? ""}`,
            "-metadata", `date=${song.publishTime ? new Date(song.publishTime).getFullYear() : ""}`,
        ];

        let codec: string[];
        switch (fmt) {
            case "flac": codec = ["-c:a", "flac"]; break;
            case "wav": codec = ["-c:a", "pcm_s16le"]; break;
            case "opus": codec = ["-c:a", "libopus", "-b:a", "96k"]; break;
            case "aac": codec = ["-c:a", "aac", "-b:a", "128k"]; break;
            case "m4a": codec = ["-c:a", "aac", "-b:a", "256k"]; break;
            case "mp3": codec = ["-c:a", "libmp3lame", "-b:a", "320k"]; break;
            default: codec = ["-c", "copy"];
        }

        const base = ["-hide_banner", "-loglevel", "error", "-i", input];

        if (cover && !["copy", "wav", "opus", "aac"].includes(fmt)) {
            return [...base, "-i", cover, "-map", "0:a", "-map",  "1", ...codec, "-id3v2_version", "3", ...meta, "-disposition:v:0", "attached_pic", "-y", output];
        }
        return [...base, "-map", "0:a:0", ...codec, "-id3v2_version", "3", ...meta, "-y", output];
    }

    async downloadSong(song: ISongDetail, folder?: string): Promise<boolean> {
        const dir = folder ?? this.opts.outputDir;
        // Ensure output directory exists
        try { await ensureDir(dir); } catch { /* ignore */ }

        // Normalize fields: ISong uses artists/album/duration, ISongDetail uses ar/al/dt
        const ar: IArtist[] = (song.ar as IArtist[]) || ((song as unknown as Record<string, unknown>).artists as IArtist[]) || [];
        const al = (song.al as IAlbum) || ((song as unknown as Record<string, unknown>).album as IAlbum);
        const artistsStr = ar.map((a) => a.name).join(",");
        const songName = removeIllegalPath(`${song.name}${artistsStr ? "-" + artistsStr : ""}`);
        const ext = this.getExtension();
        const outputPath = `${dir}${songName}${ext}`;
        let tmpAudio: string | null = null;
        let tmpCover: string | null = null;

        try {
            const [source, lyricRaw] = await Promise.all([
                getAudioSource(song.id, this.opts.quality),
                this.opts.embedLyric ? api.getLyric(song.id) : Promise.resolve(null),
            ]);
            const lyric = lyricRaw as { data?: { lrc?: { lyric?: string } } } | null;
            if (!source) throw new Error("无音频链接");

            const audioRes = await fetch(source.url);
            if (!audioRes.ok) throw new Error(`HTTP ${audioRes.status}`);
            const audioData = await audioRes.bytes();
            if (audioData.length < 1024) throw new Error("音频数据异常");

            tmpAudio = await Deno.makeTempFile({ suffix: ".tmp" });
            await Deno.writeFile(tmpAudio, audioData);

            const picUrl = al?.picUrl || ((al as unknown as Record<string, unknown>)?.picUrl as string);
            if (this.opts.embedCover && picUrl) {
                try {
                    const cr = await fetch(picUrl);
                    if (cr.ok) {
                        tmpCover = await Deno.makeTempFile({ suffix: ".jpg" });
                        await Deno.writeFile(tmpCover, await cr.bytes());
                    }
                } catch { /* ignore */ }
            }

            const args = this.buildFFmpegArgs(tmpAudio, outputPath, song, tmpCover);
            const result = await new Deno.Command("ffmpeg", { args, stdout: "piped", stderr: "piped" }).output();
            if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));

            if (lyric?.data?.lrc?.lyric) {
                await Deno.writeTextFile(`${dir}${songName}.lrc`, lyric.data.lrc.lyric);
            }

            log.success(`${song.name} [${source.level}] ${formatSize(source.size)}`);
            return true;
        } catch (e) {
            log.error(`${song.name}: ${(e as Error).message}`);
            try { await Deno.remove(outputPath); } catch { /* */ }
            return false;
        } finally {
            if (tmpAudio) try { await Deno.remove(tmpAudio); } catch { /* */ }
            if (tmpCover) try { await Deno.remove(tmpCover); } catch { /* */ }
        }
    }
}

// ─── Stats display ───────────────────────────────────────────────────────────

export function showStats(title: string, stats: DownloadStats, path?: string) {
    console.log("\n" + "=".repeat(50));
    log.title(title);
    console.log("=".repeat(50));
    if (path) console.log(`保存位置: ${path}`);
    console.log(`总计: ${stats.total} 首`);
    log.success(`成功: ${stats.success} 首`);
    if (stats.failed > 0) log.error(`失败: ${stats.failed} 首`);
    console.log("=".repeat(50));
}

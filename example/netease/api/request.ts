const BASE_URL = "http://192.168.1.2:3000";

let currentCookie = "";

export function setCookie(cookie: string) {
    currentCookie = cookie;
}

export function getCookie(): string {
    return currentCookie;
}

async function readCookie(): Promise<string> {
    if (currentCookie) return currentCookie;
    try {
        currentCookie = (await Deno.readTextFile("netease.cookie")).trim();
    } catch { /* no file */ }
    return currentCookie;
}

export async function get<T = unknown>(url: string, params?: Record<string, unknown>): Promise<T> {
    const searchParams = new URLSearchParams();
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) {
                searchParams.set(k, String(v));
            }
        }
    }
    const fullUrl = `${BASE_URL}${url}?${searchParams.toString()}`;
    const cookie = await readCookie();
    const headers: Record<string, string> = {};
    if (cookie) headers["Cookie"] = cookie;
    const res = await fetch(fullUrl, { headers });
    return await res.json() as T;
}

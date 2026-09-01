const COOKIE_NAME = "quietline_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const encoder = new TextEncoder();

function configuredToken(): string | null {
  try {
    const value = Deno.env.get("QUIETLINE_ADMIN_TOKEN")?.trim();
    return value || null;
  } catch {
    return null;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

async function signature(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64Url(new Uint8Array(digest));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function isAdminTokenConfigured(): boolean {
  return configuredToken() !== null;
}

export async function verifyAdminToken(provided: string): Promise<boolean> {
  const expected = configuredToken();
  if (!expected || !provided) return false;
  const [expectedDigest, providedDigest] = await Promise.all([
    signature(expected, expected),
    signature(expected, provided),
  ]);
  return constantTimeEqual(expectedDigest, providedDigest);
}

function cookieValue(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  const pair = header.split(";").map((part) => part.trim()).find((part) =>
    part.startsWith(`${COOKIE_NAME}=`)
  );
  return pair ? pair.slice(COOKIE_NAME.length + 1) : null;
}

export async function hasAdminSession(request: Request): Promise<boolean> {
  const secret = configuredToken();
  const value = cookieValue(request);
  if (!secret || !value) return false;

  const separator = value.lastIndexOf(".");
  if (separator < 1) return false;
  const payload = value.slice(0, separator);
  const providedSignature = value.slice(separator + 1);
  const expiresAt = Number(payload.slice(0, payload.indexOf(".")));
  if (
    !Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return false;
  }
  const expectedSignature = await signature(secret, payload);
  return constantTimeEqual(expectedSignature, providedSignature);
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  return true;
}

export async function isAdminRequest(request: Request): Promise<boolean> {
  if (!sameOrigin(request)) return false;
  const headerToken = request.headers.get("x-admin-token")?.trim();
  if (headerToken && await verifyAdminToken(headerToken)) return true;
  return await hasAdminSession(request);
}

export async function createAdminCookie(secure: boolean): Promise<string> {
  const secret = configuredToken();
  if (!secret) throw new Error("QUIETLINE_ADMIN_TOKEN is not configured.");
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${expiresAt}.${crypto.randomUUID()}`;
  const signed = `${payload}.${await signature(secret, payload)}`;
  return `${COOKIE_NAME}=${signed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${
    secure ? "; Secure" : ""
  }`;
}

export function clearAdminCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
    secure ? "; Secure" : ""
  }`;
}

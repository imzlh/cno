import { getAppKv } from "./posts.ts";

export interface Subscriber {
  email: string;
  status: "active" | "unsubscribed";
  createdAt: string;
  updatedAt: string;
}

const SUBSCRIBER_PREFIX: Deno.KvKey = ["subscribers"];

async function emailKey(email: string): Promise<Deno.KvKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return [
    ...SUBSCRIBER_PREFIX,
    btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""),
  ];
}

export function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export async function saveSubscriber(emailValue: string): Promise<{
  subscriber: Subscriber;
  alreadyActive: boolean;
}> {
  const email = normalizeEmail(emailValue);
  const kv = await getAppKv();
  if (!kv) throw new Error("Deno KV is unavailable.");
  const key = await emailKey(email);
  const current = await kv.get<Subscriber>(key);
  const now = new Date().toISOString();
  const alreadyActive = current.value?.status === "active";
  const subscriber: Subscriber = current.value
    ? { ...current.value, email, status: "active", updatedAt: now }
    : { email, status: "active", createdAt: now, updatedAt: now };
  await kv.set(key, subscriber);
  return { subscriber, alreadyActive };
}

export async function unsubscribe(emailValue: string): Promise<boolean> {
  const email = normalizeEmail(emailValue);
  const kv = await getAppKv();
  if (!kv) throw new Error("Deno KV is unavailable.");
  const key = await emailKey(email);
  const current = await kv.get<Subscriber>(key);
  if (!current.value) return false;
  await kv.set(key, {
    ...current.value,
    status: "unsubscribed",
    updatedAt: new Date().toISOString(),
  });
  return true;
}

export async function deleteSubscriber(emailValue: string): Promise<boolean> {
  const email = normalizeEmail(emailValue);
  const kv = await getAppKv();
  if (!kv) throw new Error("Deno KV is unavailable.");
  const key = await emailKey(email);
  const current = await kv.get<Subscriber>(key);
  if (!current.value) return false;
  await kv.delete(key);
  return true;
}

export async function listSubscribers(): Promise<Subscriber[]> {
  const kv = await getAppKv();
  if (!kv) return [];
  const subscribers: Subscriber[] = [];
  for await (
    const entry of kv.list<Subscriber>({ prefix: SUBSCRIBER_PREFIX })
  ) {
    if (
      entry.value?.email &&
      (entry.value.status === "active" || entry.value.status === "unsubscribed")
    ) {
      subscribers.push(entry.value);
    }
  }
  return subscribers.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function countActiveSubscribers(): Promise<number> {
  const subscribers = await listSubscribers();
  return subscribers.filter((subscriber) => subscriber.status === "active")
    .length;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const visible = local.length > 2
    ? `${local.slice(0, 2)}...`
    : `${local[0]}...`;
  return `${visible}@${domain}`;
}

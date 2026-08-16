export type PostStatus = "draft" | "published";

export interface Post {
  id: string;
  slug: string;
  title: string;
  category: string;
  excerpt: string;
  body: string;
  image: string;
  imageAlt: string;
  read: string;
  publishedAt: string;
  status: PostStatus;
  featured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PostInput {
  slug: string;
  title: string;
  category: string;
  excerpt: string;
  body: string;
  image: string;
  imageAlt: string;
  read: string;
  publishedAt: string;
  status: PostStatus;
  featured: boolean;
}

export interface ListPostOptions {
  includeDrafts?: boolean;
}

export class StorageUnavailableError extends Error {
  constructor() {
    super("Deno KV is unavailable. Start the app with KV enabled.");
    this.name = "StorageUnavailableError";
  }
}

export class PostConflictError extends Error {
  constructor(slug: string) {
    super(`A post with the slug "${slug}" already exists.`);
    this.name = "PostConflictError";
  }
}

export class PostNotFoundError extends Error {
  constructor(slug: string) {
    super(`Post "${slug}" was not found.`);
    this.name = "PostNotFoundError";
  }
}

const POST_PREFIX: Deno.KvKey = ["posts"];
const SEEDED_KEY: Deno.KvKey = ["meta", "posts-seeded-v1"];

export const seedPosts: Post[] = [
  {
    id: "seed-making-less",
    slug: "the-case-for-making-less",
    title: "The case for making less",
    category: "Practice",
    excerpt:
      "A field guide to a more deliberate creative practice, where subtraction is part of the work.",
    body:
      "The pressure to make more rarely arrives as a direct instruction. It hides inside a full backlog, a crowded desk, and the uneasy feeling that standing still means falling behind.\n\nMaking less begins with a different question: what deserves to exist? It asks us to notice which ideas keep returning after the excitement has worn off, and which ones only looked useful because they were urgent.\n\n## Leave room around the work\n\nA useful constraint is not a smaller ambition. It is a clear edge. Decide how often you will publish, how many things can be active at once, and what you are willing to leave unfinished. The boundary gives the work enough space to take a recognizable shape.\n\nThe quiet days count too. Reading, walking, revising a sentence, or removing a screen can be the work even when there is nothing new to announce.\n\n> The point is not to produce less care. It is to spend that care where it can still be felt.\n\nA deliberate practice has a slower pulse, but it is not idle. It keeps enough energy in reserve to notice when the right thing finally arrives.",
    image:
      "https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=1600&q=86",
    imageAlt: "A quiet mountain range under a clear sky",
    read: "8 min read",
    publishedAt: "2026-08-10T12:00:00.000Z",
    status: "published",
    featured: true,
    createdAt: "2026-08-08T09:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
  },
  {
    id: "seed-quieter-internet",
    slug: "the-internet-is-quieter-when-you-stop-shouting",
    title: "The internet is quieter when you stop shouting",
    category: "Field notes",
    excerpt:
      "A small argument for slower interfaces, fewer notifications, and making room for the good stuff to arrive.",
    body:
      "A surprising amount of the web is designed like a room where everyone has been told to speak first. Badges ask to be cleared. Feeds refresh before we have finished reading. Every surface wants to become the most important one.\n\nThe alternative is not an empty screen. It is a screen with manners: one that waits, remembers where you were, and makes the next action obvious without making it loud.\n\n## Quiet is a design decision\n\nStart by removing anything that exists only to create return visits. Keep notifications for events that truly change a person's next decision. Let finished states look finished instead of immediately suggesting another task.\n\nA calmer interface earns attention by respecting it. That bargain is slower to measure, but easier to live with.\n\nThe web does not become quiet all at once. It happens one considerate default at a time.",
    image:
      "https://images.unsplash.com/photo-1499750310107-5fef28a66643?auto=format&fit=crop&w=1400&q=84",
    imageAlt: "A notebook and laptop on a calm wooden desk",
    read: "6 min read",
    publishedAt: "2026-08-02T12:00:00.000Z",
    status: "published",
    featured: false,
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
  },
  {
    id: "seed-empty-space",
    slug: "a-pocket-guide-to-useful-empty-space",
    title: "A pocket guide to useful empty space",
    category: "Design",
    excerpt:
      "What a well-placed pause can do for a screen, a room, and the way we think.",
    body:
      "Empty space is often treated as the part of a design that has not been used yet. In practice, it is one of the few tools that can change the meaning of everything around it without adding another object.\n\nSpace separates unlike ideas and gathers related ones. It slows the eye before a difficult sentence. It can turn a control from one item in a pile into the clear next step.\n\n## Give the important thing a wider margin\n\nWhen a page feels busy, resist shrinking everything at once. Choose the one element that carries the decision and increase the space around it. Then remove the labels that repeat what the layout already says.\n\nUseful empty space is rarely symmetrical. A little more room below a heading, or beside a photograph, often feels more natural than a perfectly even frame.\n\nThink of space as punctuation. A comma, a full stop, and a new paragraph are all empty marks with different jobs.",
    image:
      "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1400&q=84",
    imageAlt: "A bright, restrained studio with generous open space",
    read: "4 min read",
    publishedAt: "2026-07-21T12:00:00.000Z",
    status: "published",
    featured: false,
    createdAt: "2026-07-19T08:30:00.000Z",
    updatedAt: "2026-07-21T12:00:00.000Z",
  },
  {
    id: "seed-tiny-thing",
    slug: "ship-the-tiny-thing",
    title: "Ship the tiny thing",
    category: "Making",
    excerpt:
      "Notes from a week spent choosing the smallest version that could still be worth using.",
    body:
      "Small releases are usually described as a way to move faster. Their better quality is that they make the truth arrive sooner. A real person using a narrow thing can teach you more than another week spent describing a broad one.\n\nThe trick is to keep the part that makes the idea distinct. A tiny version should be complete in one direction, not thin in every direction.\n\n## Choose one promise\n\nWrite down the single change a person should feel after using what you made. Keep the screens, words, and decisions required for that promise. Put the rest somewhere you can forget about for a while.\n\nThen finish the edges. Add the empty state. Make the error legible. Give people a way back. Small does not have to mean careless.\n\nShipping the tiny thing is less dramatic than announcing the big one. It is also how a practice learns to trust itself.",
    image:
      "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1400&q=84",
    imageAlt: "A focused workspace with a laptop and handwritten notes",
    read: "5 min read",
    publishedAt: "2026-07-08T12:00:00.000Z",
    status: "published",
    featured: false,
    createdAt: "2026-07-05T11:15:00.000Z",
    updatedAt: "2026-07-08T12:00:00.000Z",
  },
];

let kvPromise: Promise<Deno.Kv | null> | undefined;

function postKey(slug: string): Deno.KvKey {
  return [...POST_PREFIX, slug];
}

function isPost(value: unknown): value is Post {
  if (typeof value !== "object" || value === null) return false;
  const post = value as Partial<Post>;
  return typeof post.id === "string" &&
    typeof post.slug === "string" &&
    typeof post.title === "string" &&
    (post.status === "draft" || post.status === "published");
}

async function seedKv(kv: Deno.Kv): Promise<void> {
  const seeded = await kv.get<boolean>(SEEDED_KEY);
  if (seeded.value) return;

  let operation = kv.atomic().check(seeded);
  for (const post of seedPosts) {
    operation = operation.set(postKey(post.slug), post);
  }
  operation = operation.set(SEEDED_KEY, true);
  await operation.commit();
}

async function openPostKv(): Promise<Deno.Kv | null> {
  if (!kvPromise) {
    kvPromise = (async () => {
      try {
        // Keep this app's local store separate from other Deno processes on Windows.
        const path = Deno.env.get("QUIETLINE_KV_PATH")?.trim() ||
          "./.quietline-kv.sqlite3";
        const kv = await Deno.openKv(path);
        await seedKv(kv);
        return kv;
      } catch (error) {
        console.error("Quiet line could not open Deno KV:", error);
        return null;
      }
    })();
  }
  return await kvPromise;
}

export async function isStorageAvailable(): Promise<boolean> {
  return (await openPostKv()) !== null;
}

function sortNewestFirst(posts: Post[]): Post[] {
  return posts.sort((a, b) =>
    Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
  );
}

export async function listPosts(
  options: ListPostOptions = {},
): Promise<Post[]> {
  const kv = await openPostKv();
  const posts: Post[] = [];

  if (kv) {
    for await (const entry of kv.list<Post>({ prefix: POST_PREFIX })) {
      if (isPost(entry.value)) posts.push(entry.value);
    }
  } else {
    posts.push(...seedPosts);
  }

  const visiblePosts = options.includeDrafts
    ? posts
    : posts.filter((post) => post.status === "published");
  return sortNewestFirst(visiblePosts);
}

export async function getPost(
  slug: string,
  includeDrafts = false,
): Promise<Post | null> {
  const kv = await openPostKv();
  const post = kv
    ? (await kv.get<Post>(postKey(slug))).value
    : seedPosts.find((item) => item.slug === slug) ?? null;

  if (!isPost(post)) return null;
  if (!includeDrafts && post.status !== "published") return null;
  return post;
}

export async function savePost(
  input: PostInput,
  originalSlug?: string,
): Promise<Post> {
  const kv = await openPostKv();
  if (!kv) throw new StorageUnavailableError();

  const sourceSlug = originalSlug || input.slug;
  const existing = await kv.get<Post>(postKey(sourceSlug));
  if (originalSlug && !isPost(existing.value)) {
    throw new PostNotFoundError(originalSlug);
  }
  if (!originalSlug && isPost(existing.value)) {
    throw new PostConflictError(sourceSlug);
  }

  if (input.slug !== sourceSlug) {
    const conflict = await kv.get<Post>(postKey(input.slug));
    if (isPost(conflict.value)) throw new PostConflictError(input.slug);
  }

  const now = new Date().toISOString();
  const post: Post = {
    ...input,
    id: isPost(existing.value) ? existing.value.id : crypto.randomUUID(),
    createdAt: isPost(existing.value) ? existing.value.createdAt : now,
    updatedAt: now,
  };

  let operation = kv.atomic().set(postKey(post.slug), post);
  if (sourceSlug !== post.slug) {
    operation = operation.delete(postKey(sourceSlug));
  }
  await operation.commit();
  return post;
}

export async function deletePost(slug: string): Promise<void> {
  const kv = await openPostKv();
  if (!kv) throw new StorageUnavailableError();

  const existing = await kv.get<Post>(postKey(slug));
  if (!isPost(existing.value)) throw new PostNotFoundError(slug);
  await kv.delete(postKey(slug));
}

export function slugify(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

export function formatPostDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function dateInputValue(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? new Date().toISOString().slice(0, 10)
    : date.toISOString().slice(0, 10);
}

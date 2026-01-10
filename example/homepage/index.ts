// main.ts
import { Application, Router } from "jsr:@oak/oak";
import { DB } from "jsr:@db/sqlite";

const db = new DB("home.db");
db.execute(`
CREATE TABLE IF NOT EXISTS user(
  email    TEXT PRIMARY KEY,
  website  TEXT,
  message  TEXT NOT NULL
)`);

const app = new Application();
const router = new Router();

router
    .get("/api/list", (_) => {
        const rows = db.query("SELECT * FROM user");
        return _.response.body = [...rows];
    })
    .post("/api/msg", async (c) => {
        const b = c.request.body({ type: "json" }).value;
        db.query("INSERT OR REPLACE INTO user VALUES (?, ?, ?)", [
            b.email,
            b.website ?? "",
            b.message,
        ]);
        c.response.body = { ok: true };
    });

app.use(router.routes());
app.use(router.allowedMethods());

// 静态托管
app.use(async (c, next) => {
    try {
        await c.send({ root: `${Deno.cwd()}/static`, index: "index.html" });
    } catch {
        await next();
    }
});

await app.listen({ port: 8000 });
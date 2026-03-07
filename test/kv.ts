const kv = await Deno.openKv("./test.db");
await kv.set(["users", 1], { name: "test" });
const user = await kv.get(["users", 1]);
console.log(user);

console.log("Starting atomic...");
await kv.atomic()
  .set(["counter"], 1n)
  .sum(["counter"], 1n)
  .commit();
console.log("Atomic done");

kv.close();

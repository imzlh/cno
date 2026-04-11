// tcp_dump.ts - 监听 8888，打印原始 HTTP 请求
const listener = Deno.listen({ port: 8888 });
console.log("TCP dump server on :8888");

for await (const conn of listener) {
    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    if (n) {
        console.log("=== Raw HTTP Request ===");
        console.log(new TextDecoder().decode(buf.subarray(0, n)));
        console.log("=======================");
        
        // 回复简单的 200 OK
        const response = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK";
        await conn.write(new TextEncoder().encode(response));
    }
    conn.close();
}
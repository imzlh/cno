/**
 * @fileoverview Deno Web Terminal Server
 * 
 * 协议：
 * - WebSocket文本帧：JSON命令，如 {"row": 24, "col": 80}
 * - WebSocket二进制帧：终端原始数据（UTF-8）
 * - PTY输出通过二进制帧发送给客户端
 */

/// <reference path="../../src/type/lib.cno.d.ts" />

const allowedFiles: Record<string, string> = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'ico': 'image/x-icon',
    'svg': 'image/svg+xml',
    'png': 'image/png',
    'webp': 'image/webp',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
};

// 启动服务器
Deno.serve({ port: 8080 }, async (req) => {
    const url = new URL(req.url);

    console.log(`HTTP ${req.method} ${url.pathname}`);

    // WebSocket终端连接
    if (url.pathname === "/ws") {
        const { socket, response } = Deno.upgradeWebSocket(req);
        let pty: CNO.PtyPipe | null = null;

        socket.onopen = async () => {
            try {
                // 创建PTY，使用用户默认shell
                pty = await CNO.openpty({
                    argv: [Deno.env.get("SHELL") || "/bin/bash"],
                    env: {
                        ...Deno.env.toObject(),
                        // pty
                        TERM: "xterm-256color",
                        COLORTERM: "truecolor"
                    },
                    cwd: Deno.cwd(),
                    cols: 80,
                    rows: 24,
                });

                // PTY输出 -> WebSocket（二进制）
                const ptyReader = pty.readable.getReader();
                const readLoop = async () => {
                    try {
                        while (true) {
                            const { done, value } = await ptyReader.read();
                            if (done) break;
                            // value是Uint8Array，作为二进制帧发送
                            if (socket.readyState === WebSocket.OPEN) {
                                socket.send(value);
                            }
                        }
                    } catch (e) {
                        console.error("PTY read error:", e);
                    } finally {
                        ptyReader.releaseLock();
                    }
                };

                // WebSocket -> PTY输入（二进制）
                const ptyWriter = pty.writable.getWriter();
                socket.onmessage = async (event) => {
                    try {
                        if (typeof event.data === "string") {
                            // 文本帧：resize命令
                            const cmd = JSON.parse(event.data);
                            if (cmd.row && cmd.col) {
                                pty!.resize(cmd.col, cmd.row);
                            } else {
                                console.error("Invalid resize command:", cmd);
                            }
                        } else if (event.data instanceof ArrayBuffer) {
                            // 二进制帧：终端输入数据
                            await ptyWriter.write(new Uint8Array(event.data));
                        }
                    } catch (e) {
                        console.error("WebSocket message error:", e);
                    }
                };

                // 启动读取循环
                readLoop().catch(console.error);

                // 清理资源
                socket.onclose = () => {
                    pty?.kill("SIGTERM");
                    ptyWriter.releaseLock();
                };

            } catch (error) {
                console.error("PTY creation failed:", error);
                socket.close();
            }
        };

        return response;
    } else {
        // 简单的文件分发
        const pathname = url.pathname;
        const filePath = pathname === '/' ? '/index.html' : pathname;
        const fileExtension = filePath.split('.').pop()?.toLowerCase();

        if (!fileExtension || !allowedFiles[fileExtension]) {
            return new Response('Forbidden', { status: 403 });
        }

        try {
            // 尝试读取文件
            const file = await Deno.readFile(`.${filePath}`);

            return new Response(file, {
                status: 200,
                headers: {
                    'Content-Type': allowedFiles[fileExtension],
                    'Cache-Control': 'public, max-age=3600',
                },
            });
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) {
                return new Response('File not found', { status: 404 });
            }
            return new Response('Internal Server Error', { status: 500 });
        }
    }

    return new Response("Not Found", { status: 404 });
});

console.log("Web Terminal Server running at http://localhost:8080");
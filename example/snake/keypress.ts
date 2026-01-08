// keypress.ts - 修复版
let locked = false;
export async function* readGameInput() {
    // 使用更小的缓冲区，避免数据堆积
    const buffer = new Uint8Array(8);
    // ESC 序列缓冲区
    const escBuffer: number[] = [];

    if (locked) throw new Error("游戏输入已被锁定");

    try {
        Deno.stdin.setRaw(true);

        while (true) {
            locked = true;
            const n = await Deno.stdin.read(buffer);
            locked = false;

            if (!n || n === 0) continue;

            // 直接处理原始字节，不使用 TextDecoder
            for (let i = 0; i < n; i++) {
                const byte = buffer[i];

                // ESC 序列处理（0x1b = 27）
                if (escBuffer.length > 0 || byte === 0x1b) {
                    escBuffer.push(byte);

                    // 完整的方向键序列：ESC [ A/B/C/D
                    if (escBuffer.length === 3) {
                        if (escBuffer[0] === 0x1b && escBuffer[1] === 0x5b) { // ESC [
                            switch (escBuffer[2]) {
                                case 0x41: yield { key: "up" }; escBuffer.length = 0; continue;
                                case 0x42: yield { key: "down" }; escBuffer.length = 0; continue;
                                case 0x43: yield { key: "right" }; escBuffer.length = 0; continue;
                                case 0x44: yield { key: "left" }; escBuffer.length = 0; continue;
                            }
                        }
                        // 不是完整的方向键，清空缓冲
                        escBuffer.length = 0;
                    } else if (escBuffer.length > 3) {
                        // 缓冲溢出，清空
                        escBuffer.length = 0;
                    }
                    continue; // 继续处理下一个字节
                }

                // 单字节按键映射
                let key = "";
                switch (byte) {
                    case 0x0d: // \r
                    case 0x0a: // \n
                        key = "enter";
                        break;
                    case 0x20: // 空格
                        key = "space";
                        break;
                    case 0x7f: // 退格
                        key = "backspace";
                        break;
                    default:
                        // 字母键（a-z, A-Z）
                        if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)) {
                            // 统一转小写
                            key = String.fromCharCode(byte >= 0x41 && byte <= 0x5a ? byte + 32 : byte);
                        }
                }

                if (key) {
                    yield { key };
                }
            }
        }
    } catch (error) {
        console.error("输入读取错误:", error);
        throw error;
    } finally {
        try {
            Deno.stdin.setRaw(false);
        } catch (e) {
            // 忽略清理错误
        }
    }
}
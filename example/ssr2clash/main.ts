#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write
import { parseArgs } from "https://deno.land/std@0.208.0/cli/parse_args.ts";

/**
 * 通用订阅转Clash配置工具
 * 支持: VMess, VLESS, Trojan, Shadowsocks, SSR
 * 使用方法: deno run --allow-net --allow-read --allow-write sub_to_clash.ts
 */

interface ClashProxy {
    name: string;
    type: string;
    server: string;
    port: number;
    [key: string]: any;
}

interface ClashConfig {
    port?: number;
    "socks-port"?: number;
    "allow-lan"?: boolean;
    mode?: string;
    "log-level"?: string;
    "external-controller"?: string;
    proxies: ClashProxy[];
    "proxy-groups": ProxyGroup[];
    rules: string[];
    [key: string]: any;
}

interface ProxyGroup {
    name: string;
    type: string;
    proxies: string[];
    url?: string;
    interval?: number;
    [key: string]: any;
}

// 默认Clash模板
const defaultClashTemplate: Partial<ClashConfig> = {
    port: 7890,
    "socks-port": 7891,
    "allow-lan": false,
    mode: "rule",
    "log-level": "info",
    "external-controller": "127.0.0.1:9090",
    "proxy-groups": [
        {
            name: "🚀 节点选择",
            type: "select",
            proxies: ["♻️ 自动选择", "DIRECT"],
        },
        {
            name: "♻️ 自动选择",
            type: "url-test",
            proxies: [],
            url: "http://www.gstatic.com/generate_204",
            interval: 300,
        },
        {
            name: "🎯 全球直连",
            type: "select",
            proxies: ["DIRECT", "🚀 节点选择"],
        },
        {
            name: "🛑 广告拦截",
            type: "select",
            proxies: ["REJECT", "DIRECT"],
        },
    ],
    rules: [
        "DOMAIN-SUFFIX,local,DIRECT",
        "IP-CIDR,127.0.0.0/8,DIRECT",
        "IP-CIDR,172.16.0.0/12,DIRECT",
        "IP-CIDR,192.168.0.0/16,DIRECT",
        "IP-CIDR,10.0.0.0/8,DIRECT",
        "DOMAIN-SUFFIX,cn,🎯 全球直连",
        "GEOIP,CN,🎯 全球直连",
        "MATCH,🚀 节点选择",
    ],
};

// 解析 VMess 链接
function parseVMessUrl(url: string): ClashProxy | null {
    try {
        if (!url.startsWith("vmess://")) return null;

        const base64Content = url.substring(8);
        const decoded = atob(base64Content);
        const config = JSON.parse(decoded);

        const proxy: ClashProxy = {
            name: config.ps || `${config.add}:${config.port}`,
            type: "vmess",
            server: config.add,
            port: parseInt(config.port),
            uuid: config.id,
            alterId: parseInt(config.aid || "0"),
            cipher: config.scy || "auto",
            udp: true,
        };

        // 处理网络类型
        if (config.net) {
            proxy.network = config.net;

            if (config.net === "ws") {
                proxy["ws-opts"] = {
                    path: config.path || "/",
                    headers: config.host ? { Host: config.host } : {},
                };
            } else if (config.net === "h2") {
                proxy["h2-opts"] = {
                    path: config.path || "/",
                    host: config.host ? [config.host] : [],
                };
            } else if (config.net === "grpc") {
                proxy["grpc-opts"] = {
                    "grpc-service-name": config.path || "",
                };
            }
        }

        // TLS 配置
        if (config.tls === "tls") {
            proxy.tls = true;
            if (config.sni) {
                proxy.servername = config.sni;
            } else if (config.host) {
                proxy.servername = config.host;
            }
            if (config.alpn) {
                proxy.alpn = [config.alpn];
            }
        }

        return proxy;
    } catch (e) {
        console.error("解析 VMess 链接失败:", e);
        return null;
    }
}

// 解析 VLESS 链接
function parseVLessUrl(url: string): ClashProxy | null {
    try {
        if (!url.startsWith("vless://")) return null;

        const urlObj = new URL(url.substring(8));
        const uuid = urlObj.username;
        const server = urlObj.hostname;
        const port = parseInt(urlObj.port);
        const params = new URLSearchParams(urlObj.search);

        const proxy: ClashProxy = {
            name: decodeURIComponent(urlObj.hash.substring(1)) || `${server}:${port}`,
            type: "vless",
            server,
            port,
            uuid,
            udp: true,
        };

        // 网络类型
        const network = params.get("type") || "tcp";
        proxy.network = network;

        if (network === "ws") {
            proxy["ws-opts"] = {
                path: params.get("path") || "/",
                headers: params.get("host") ? { Host: params.get("host")! } : {},
            };
        } else if (network === "grpc") {
            proxy["grpc-opts"] = {
                "grpc-service-name": params.get("serviceName") || "",
            };
        }

        // TLS
        const security = params.get("security");
        if (security === "tls") {
            proxy.tls = true;
            if (params.get("sni")) {
                proxy.servername = params.get("sni")!;
            }
        } else if (security === "reality") {
            proxy.tls = true;
            proxy["reality-opts"] = {
                "public-key": params.get("pbk") || "",
                "short-id": params.get("sid") || "",
            };
            if (params.get("sni")) {
                proxy.servername = params.get("sni")!;
            }
        }

        // Flow
        if (params.get("flow")) {
            proxy.flow = params.get("flow")!;
        }

        return proxy;
    } catch (e) {
        console.error("解析 VLESS 链接失败:", e);
        return null;
    }
}

// 解析 Trojan 链接
function parseTrojanUrl(url: string): ClashProxy | null {
    try {
        if (!url.startsWith("trojan://")) return null;

        const urlObj = new URL(url);
        const password = urlObj.username;
        const server = urlObj.hostname;
        const port = parseInt(urlObj.port);
        const params = new URLSearchParams(urlObj.search);

        const proxy: ClashProxy = {
            name: decodeURIComponent(urlObj.hash.substring(1)) || `${server}:${port}`,
            type: "trojan",
            server,
            port,
            password,
            udp: true,
        };

        // SNI
        if (params.get("sni")) {
            proxy.sni = params.get("sni")!;
        }

        // 网络类型
        const network = params.get("type");
        if (network === "ws") {
            proxy.network = "ws";
            proxy["ws-opts"] = {
                path: params.get("path") || "/",
                headers: params.get("host") ? { Host: params.get("host")! } : {},
            };
        } else if (network === "grpc") {
            proxy.network = "grpc";
            proxy["grpc-opts"] = {
                "grpc-service-name": params.get("serviceName") || "",
            };
        }

        // 跳过证书验证
        if (params.get("allowInsecure") === "1") {
            proxy["skip-cert-verify"] = true;
        }

        return proxy;
    } catch (e) {
        console.error("解析 Trojan 链接失败:", e);
        return null;
    }
}

// 解析 Shadowsocks 链接
function parseShadowsocksUrl(url: string): ClashProxy | null {
    try {
        if (!url.startsWith("ss://")) return null;

        let decoded: string;
        let name = "";

        // 处理带注释的情况
        if (url.includes("#")) {
            const [main, hash] = url.split("#");
            name = decodeURIComponent(hash);
            url = main;
        }

        // 旧格式: ss://base64(method:password@server:port)
        // 新格式: ss://base64(method:password)@server:port
        const content = url.substring(5);

        if (content.includes("@")) {
            const parts = content.split("@");
            if (parts.length === 2) {
                const [encodedAuth, serverPort] = parts;
                const auth = atob(encodedAuth);
                const [method, password] = auth.split(":");
                const [server, port] = serverPort.split(":");

                return {
                    name: name || `${server}:${port}`,
                    type: "ss",
                    server,
                    port: parseInt(port),
                    cipher: method,
                    password,
                    udp: true,
                };
            }
        } else {
            // 完全 base64 编码
            decoded = atob(content);
            const match = decoded.match(/^(.+?):(.+)@(.+):(\d+)$/);
            if (match) {
                const [, method, password, server, port] = match;
                return {
                    name: name || `${server}:${port}`,
                    type: "ss",
                    server,
                    port: parseInt(port),
                    cipher: method,
                    password,
                    udp: true,
                };
            }
        }

        return null;
    } catch (e) {
        console.error("解析 Shadowsocks 链接失败:", e);
        return null;
    }
}

// 解析 SSR 链接
function parseSSRUrl(url: string): ClashProxy | null {
    try {
        if (!url.startsWith("ssr://")) return null;

        const base64Content = url.substring(6);
        const decoded = atob(base64Content.replace(/_/g, "/").replace(/-/g, "+"));

        const [mainPart, paramsPart] = decoded.split("/?");
        const parts = mainPart.split(":");

        if (parts.length < 6) return null;

        const [server, portStr, protocol, method, obfs, passwordBase64] = parts;
        const password = atob(
            passwordBase64.replace(/_/g, "/").replace(/-/g, "+")
        );

        const proxy: ClashProxy = {
            name: `${server}:${portStr}`,
            type: "ssr",
            server,
            port: parseInt(portStr),
            cipher: method,
            password,
            obfs,
            protocol,
            udp: true,
        };

        if (paramsPart) {
            const params = new URLSearchParams(paramsPart);

            if (params.has("obfsparam")) {
                proxy["obfs-param"] = atob(
                    params.get("obfsparam")!.replace(/_/g, "/").replace(/-/g, "+")
                );
            }
            if (params.has("protoparam")) {
                proxy["protocol-param"] = atob(
                    params.get("protoparam")!.replace(/_/g, "/").replace(/-/g, "+")
                );
            }
            if (params.has("remarks")) {
                proxy.name = atob(
                    params.get("remarks")!.replace(/_/g, "/").replace(/-/g, "+")
                );
            }
        }

        return proxy;
    } catch (e) {
        console.error("解析 SSR 链接失败:", e);
        return null;
    }
}

// 解析单个代理链接
function parseProxyUrl(url: string): ClashProxy | null {
    url = url.trim();

    if (url.startsWith("vmess://")) {
        return parseVMessUrl(url);
    } else if (url.startsWith("vless://")) {
        return parseVLessUrl(url);
    } else if (url.startsWith("trojan://")) {
        return parseTrojanUrl(url);
    } else if (url.startsWith("ss://")) {
        return parseShadowsocksUrl(url);
    } else if (url.startsWith("ssr://")) {
        return parseSSRUrl(url);
    }

    return null;
}

// 从URL获取订阅
async function fetchSubscription(url: string): Promise<string[]> {
    try {
        console.log("正在获取订阅内容...");
        const response = await fetch(url);
        console.log('HTTP', response.status, response.statusText);
        const text = await response.text();

        // 尝试 base64 解码
        let content: string;
        try {
            content = atob(text.trim());
            console.log("✓ 订阅内容已解码");
        } catch {
            content = text;
            console.log("✓ 订阅内容无需解码");
        }

        // 分割成多行
        const lines = content
            .split(/[\r\n]+/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        return lines;
    } catch (e) {
        console.error("获取订阅失败:", e);
        throw e;
    }
}

// 生成Clash配置
function generateClashConfig(
    proxies: ClashProxy[],
    template?: Partial<ClashConfig>
): ClashConfig {
    const baseTemplate = { ...defaultClashTemplate, ...template };

    const proxyNames = proxies.map((p) => p.name);

    // 更新代理组
    const proxyGroups = baseTemplate["proxy-groups"]!.map((group) => {
        if (group.name === "🚀 节点选择") {
            return {
                ...group,
                proxies: ["♻️ 自动选择", ...proxyNames, "DIRECT"],
            };
        } else if (group.name === "♻️ 自动选择") {
            return {
                ...group,
                proxies: proxyNames,
            };
        }
        return group;
    });

    return {
        ...baseTemplate,
        proxies,
        "proxy-groups": proxyGroups,
        rules: baseTemplate.rules || [],
    } as ClashConfig;
}

// JSON 转 YAML
function jsonToYaml(obj: any, indent = 0): string {
    const spaces = "  ".repeat(indent);
    let result = "";

    if (Array.isArray(obj)) {
        for (const item of obj) {
            if (typeof item === "object" && item !== null) {
                result += `${spaces}- `;
                const itemYaml = jsonToYaml(item, indent + 1);
                const lines = itemYaml.trim().split("\n");
                result += lines[0].trim() + "\n";
                for (let i = 1; i < lines.length; i++) {
                    result += `${spaces}  ${lines[i].trim()}\n`;
                }
            } else {
                result += `${spaces}- ${formatValue(item)}\n`;
            }
        }
    } else if (typeof obj === "object" && obj !== null) {
        for (const [key, value] of Object.entries(obj)) {
            if (Array.isArray(value)) {
                result += `${spaces}${key}:\n`;
                result += jsonToYaml(value, indent + 1);
            } else if (typeof value === "object" && value !== null) {
                result += `${spaces}${key}:\n`;
                result += jsonToYaml(value, indent + 1);
            } else {
                result += `${spaces}${key}: ${formatValue(value)}\n`;
            }
        }
    }

    return result;
}

function formatValue(value: any): string {
    if (typeof value === "string") {
        if (
            value.includes(":") ||
            value.includes("#") ||
            value.includes(",") ||
            value.includes("@")
        ) {
            return `"${value.replace(/"/g, '\\"')}"`;
        }
        return value;
    }
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    return String(value);
}

/* ----------------------------  参数解析  ---------------------------- */
interface Flags {
    url?: string;          // 订阅链接
    template?: string;     // 模板文件路径
    output?: string;       // 输出文件路径
    help?: boolean;        // 显示帮助
}

function parse(): Flags {
    const args = parseArgs(Deno.args, {
        string: ["url", "template", "output"],
        boolean: ["help"],
        alias: { h: "help", u: "url", t: "template", o: "output" },
        unknown: (arg) => {
            console.error(`未知参数: ${arg}`);
            Deno.exit(1);
        },
    });
    if (args.help) {
        console.log(`
通用订阅转 Clash 配置工具

用法:
  deno run -A main.ts [选项]

选项:
  -u, --url <订阅链接>        必填，订阅地址
  -t, --template <模板路径>   可选，Clash 模板文件（JSON/YAML）
  -o, --output <输出路径>     可选，默认 clash.yaml
  -h, --help                  显示本帮助
`);
        Deno.exit(0);
    }
    return args as Flags;
}

/* ----------------------------  CLI 模式  ---------------------------- */
async function runCli(flags: Flags) {
    if (!flags.url) {
        console.error("CLI 模式下必须提供 --url 参数");
        Deno.exit(1);
    }
    const { url, template, output = "clash.yaml" } = flags;

    // 读取模板
    let customTemplate: Partial<ClashConfig> | undefined;
    if (template) {
        try {
            const txt = await Deno.readTextFile(template);
            customTemplate = template.endsWith(".json")
                ? JSON.parse(txt)
                : JSON.parse(txt); // 简化：假设已是 JSON
            console.log("✓ 已加载自定义模板");
        } catch (e) {
            console.error("读取模板失败，使用默认模板:", e);
        }
    }

    // 拉取 & 解析
    const lines = await fetchSubscription(url);
    const proxies: ClashProxy[] = [];
    const stats = { vmess: 0, vless: 0, trojan: 0, ss: 0, ssr: 0, failed: 0 };
    for (const line of lines) {
        const p = parseProxyUrl(line);
        if (p) {
            proxies.push(p);
            stats[p.type as keyof typeof stats]++;
        } else stats.failed++;
    }
    if (!proxies.length) {
        console.error("没有可用节点");
        Deno.exit(1);
    }

    // 生成 & 写出
    const clashConfig = generateClashConfig(proxies, customTemplate);
    const yaml = jsonToYaml(clashConfig);
    await Deno.writeTextFile(output, yaml);
    console.log(`\n✓ 配置已写入: ${output}  (${proxies.length} 个节点)`);
}

/* ----------------------------  交互模式  ---------------------------- */
async function runInteractive() {
    console.log("=== 通用订阅转 Clash 配置工具 ===");
    console.log("支持协议: VMess, VLESS, Trojan, Shadowsocks, SSR\n");

    const subscriptionUrl = prompt("请输入订阅链接:");
    if (!subscriptionUrl) {
        console.error("未提供订阅链接");
        Deno.exit(1);
    }

    const templatePath = prompt("请输入 Clash 模板文件路径 (留空使用默认模板):");
    let customTemplate: Partial<ClashConfig> | undefined;
    if (templatePath?.trim()) {
        try {
            const txt = await Deno.readTextFile(templatePath.trim());
            customTemplate = templatePath.endsWith(".json")
                ? JSON.parse(txt)
                : JSON.parse(txt); // 同上，简化
            console.log("✓ 已加载自定义模板\n");
        } catch (e) {
            console.error("读取模板失败，使用默认模板:", e);
        }
    }

    const lines = await fetchSubscription(subscriptionUrl);
    console.log(`✓ 获取到 ${lines.length} 行内容\n`);

    const proxies: ClashProxy[] = [];
    const stats = { vmess: 0, vless: 0, trojan: 0, ss: 0, ssr: 0, failed: 0 };
    for (const line of lines) {
        const p = parseProxyUrl(line);
        if (p) {
            proxies.push(p);
            stats[p.type as keyof typeof stats]++;
        } else stats.failed++;
    }

    console.log(`✓ 成功解析 ${proxies.length} 个节点`);
    Object.entries(stats).forEach(([k, v]) => v && console.log(`  - ${k}: ${v}`));
    console.log();

    if (!proxies.length) {
        console.error("没有可用节点");
        Deno.exit(1);
    }

    const clashConfig = generateClashConfig(proxies, customTemplate);
    const outputPath = prompt("请输入输出文件路径 (默认: clash.yaml):") || "clash.yaml";
    const yaml = jsonToYaml(clashConfig);
    await Deno.writeTextFile(outputPath, yaml);
    console.log(`\n✓ 配置已保存到: ${outputPath}  (${proxies.length} 个节点)`);
}

/* ----------------------------  主入口  ---------------------------- */
if (import.meta.main) {
    const flags = parse();
    try {
        // 只要检测到 --url 就认为走 CLI，否则走交互
        if (Deno.args.some((a) => a === "--url" || a === "-u")) {
            await runCli(flags);
        } else {
            await runInteractive();
        }
    } catch (e) {
        console.error("发生错误:", e);
        Deno.exit(1);
    }
}
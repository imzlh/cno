#!/usr/bin/env -S cno

/**
 * SSR订阅转Clash配置工具
 */

interface SSRConfig {
    server: string;
    port: number;
    protocol: string;
    method: string;
    obfs: string;
    password: string;
    obfsparam?: string;
    protoparam?: string;
    remarks?: string;
    group?: string;
}

interface ClashProxy {
    name: string;
    type: string;
    server: string;
    port: number;
    cipher: string;
    password: string;
    obfs?: string;
    protocol?: string;
    "obfs-param"?: string;
    "protocol-param"?: string;
    udp?: boolean;
}

interface ClashConfig {
    port?: number;
    "socks-port"?: number;
    "allow-lan"?: boolean;
    mode?: string;
    "log-level"?: string;
    "external-controller"?: string;
    proxies: ClashProxy[];
    "proxy-groups": Array<{
        name: string;
        type: string;
        proxies: string[];
        url?: string;
        interval?: number;
    }>;
    rules: string[];
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

// 解析SSR链接
function parseSSRUrl(url: string): SSRConfig | null {
    try {
        // SSR链接格式: ssr://base64编码的内容
        if (!url.startsWith("ssr://")) {
            return null;
        }

        const base64Content = url.substring(6);
        const decoded = atob(base64Content);

        // 格式: server:port:protocol:method:obfs:password_base64/?params
        const [mainPart, paramsPart] = decoded.split("/?");
        const parts = mainPart.split(":");

        if (parts.length < 6) {
            return null;
        }

        const [server, portStr, protocol, method, obfs, passwordBase64] = parts;
        const password = atob(passwordBase64.replace(/_/g, "/").replace(/-/g, "+"));

        const config: SSRConfig = {
            server,
            port: parseInt(portStr),
            protocol,
            method,
            obfs,
            password,
        };

        // 解析参数
        if (paramsPart) {
            const params = new URLSearchParams(paramsPart);

            if (params.has("obfsparam")) {
                config.obfsparam = atob(params.get("obfsparam")!.replace(/_/g, "/").replace(/-/g, "+"));
            }
            if (params.has("protoparam")) {
                config.protoparam = atob(params.get("protoparam")!.replace(/_/g, "/").replace(/-/g, "+"));
            }
            if (params.has("remarks")) {
                config.remarks = atob(params.get("remarks")!.replace(/_/g, "/").replace(/-/g, "+"));
            }
            if (params.has("group")) {
                config.group = atob(params.get("group")!.replace(/_/g, "/").replace(/-/g, "+"));
            }
        }

        return config;
    } catch (e) {
        console.error("解析SSR链接失败:", e);
        return null;
    }
}

// 将SSR配置转换为Clash代理
function ssrToClashProxy(ssr: SSRConfig): ClashProxy {
    const proxy: ClashProxy = {
        name: ssr.remarks || `${ssr.server}:${ssr.port}`,
        type: "ssr",
        server: ssr.server,
        port: ssr.port,
        cipher: ssr.method,
        password: ssr.password,
        obfs: ssr.obfs,
        protocol: ssr.protocol,
        udp: true,
    };

    if (ssr.obfsparam) {
        proxy["obfs-param"] = ssr.obfsparam;
    }
    if (ssr.protoparam) {
        proxy["protocol-param"] = ssr.protoparam;
    }

    return proxy;
}

// 从URL获取SSR订阅
async function fetchSSRSubscription(url: string): Promise<string[]> {
    try {
        const response = await fetch(url);
        console.log(`✓ HTTP ${response.status}: ${response.url}`);
        const text = await response.text();

        // 订阅内容可能是base64编码的
        let content: string;
        try {
            content = atob(text);
        } catch {
            content = text;
        }

        // 分割成多个SSR链接
        return content
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("ssr://"));
    } catch (e) {
        console.error("获取SSR订阅失败:", e);
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

    // 更新代理组中的节点列表
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

// 主函数
async function main() {
    console.log("=== SSR订阅转Clash配置工具 ===\n");

    // 读取配置
    const ssrSubscriptionUrl = prompt("请输入SSR订阅链接:");
    if (!ssrSubscriptionUrl) {
        console.error("未提供订阅链接");
        Deno.exit(1);
    }

    const templatePath = prompt("请输入Clash模板文件路径 (留空使用默认模板):");

    let customTemplate: Partial<ClashConfig> | undefined;
    if (templatePath) {
        try {
            const templateContent = await Deno.readTextFile(templatePath);
            customTemplate = JSON.parse(templateContent);
            console.log("✓ 已加载自定义模板");
        } catch (e) {
            console.error("读取模板文件失败，使用默认模板:", e);
        }
    }

    console.log("\n正在获取SSR订阅...");
    const ssrUrls = await fetchSSRSubscription(ssrSubscriptionUrl);
    console.log(`✓ 获取到 ${ssrUrls.length} 个节点`);

    console.log("\n正在解析节点...");
    const ssrConfigs = ssrUrls
        .map(parseSSRUrl)
        .filter((config): config is SSRConfig => config !== null);
    console.log(`✓ 成功解析 ${ssrConfigs.length} 个节点`);

    if (ssrConfigs.length === 0) {
        console.error("没有可用的节点");
        Deno.exit(1);
    }

    console.log("\n正在生成Clash配置...");
    const clashProxies = ssrConfigs.map(ssrToClashProxy);
    const clashConfig = generateClashConfig(clashProxies, customTemplate);

    const outputPath = prompt("请输入输出文件路径 (默认: clash.yaml):") || "clash.yaml";

    // 将配置转换为YAML格式 (简单实现)
    const yaml = jsonToYaml(clashConfig);
    await Deno.writeTextFile(outputPath, yaml);

    console.log(`\n✓ Clash配置已保存到: ${outputPath}`);
    console.log(`✓ 共包含 ${clashProxies.length} 个代理节点`);
}

// 简单的JSON转YAML实现
function jsonToYaml(obj: any, indent = 0): string {
    const spaces = "  ".repeat(indent);
    let result = "";

    if (Array.isArray(obj)) {
        for (const item of obj) {
            if (typeof item === "object" && item !== null) {
                result += `${spaces}- `;
                const itemYaml = jsonToYaml(item, indent + 1);
                result += itemYaml.trim().substring(spaces.length + 2) + "\n";
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
        // 如果字符串包含特殊字符，使用引号
        if (value.includes(":") || value.includes("#") || value.includes(",")) {
            return `"${value}"`;
        }
        return value;
    }
    return String(value);
}

// 运行主函数
if (import.meta.main) {
    main().catch((e) => {
        console.error("发生错误:", e);
        Deno.exit(1);
    });
}
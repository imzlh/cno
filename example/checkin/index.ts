#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write

/**
 * Write360 自动签到脚本
 * 使用方法: deno run --allow-net --allow-read --allow-write signin.ts
 */

const BASE_URL = "https://chat.write360.cn";
const TOKEN_FILE = "token.json";

interface TokenData {
    token: string;
    timestamp: number;
}

interface UserInfo {
    username: string;
}

interface UserBalance {
    sumModel3Count: number;
}

interface GetInfoResponse {
    code: number;
    data?: {
        userInfo?: UserInfo;
        userBalance?: UserBalance;
    };
    message?: string;
}

interface LoginResponse {
    code: number;
    data?: string;
    success?: boolean;
    message?: string;
}

interface SignResponse {
    code: number;
    data?: string;
    success?: boolean;
    message?: string;
}

// 读取保存的 Token
async function loadToken(): Promise<string | null> {
    try {
        const content = await Deno.readTextFile(TOKEN_FILE);
        const data: TokenData = JSON.parse(content);

        // JWT token 包含过期时间，这里简单检查是否在30天内
        const now = Date.now();
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;

        if (now - data.timestamp < thirtyDays) {
            console.log("✓ 加载已保存的 Token");
            return data.token;
        } else {
            console.log("⚠ Token 可能已过期，需要重新登录");
            return null;
        }
    } catch {
        console.log("⚠ 未找到已保存的 Token");
        return null;
    }
}

// 保存 Token
async function saveToken(token: string): Promise<void> {
    const data: TokenData = {
        token,
        timestamp: Date.now(),
    };
    await Deno.writeTextFile(TOKEN_FILE, JSON.stringify(data, null, 2));
    console.log("✓ Token 已保存");
}

// 登录获取 JWT Token
async function login(): Promise<string | null> {
    console.log("→ 正在登录...");

    try {
        const response = await fetch(`${BASE_URL}/api/auth/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                username: prompt("请输入用户名: "),
                password: prompt("请输入密码: "),
            }),
        });

        const data = await response.json() as LoginResponse;

        if (data.code === 200 && data.success && data.data) {
            console.log("✓ 登录成功");
            await saveToken(data.data);
            return data.data;
        } else {
            console.error(`✗ 登录失败: ${data.message || "未知错误"}`);
            return null;
        }
    } catch (error) {
        console.error(`✗ 登录请求失败: ${error}`);
        return null;
    }
}

// 获取用户信息
async function getUserInfo(token: string): Promise<GetInfoResponse> {
    console.log("→ 正在获取用户信息...");

    const response = await fetch(`${BASE_URL}/api/auth/getInfo`, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
        },
    });

    const data = await response.json() as GetInfoResponse;
    return data;
}

// 签到
async function sign(token: string): Promise<SignResponse> {
    console.log("→ 正在签到...");

    const response = await fetch(`${BASE_URL}/api/signin/sign`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({}),
    });

    const data = await response.json() as SignResponse;
    return data;
}

// 主函数
async function main() {
    console.log("=".repeat(50));
    console.log("Write360 自动签到脚本");
    console.log(`执行时间: ${new Date().toLocaleString("zh-CN")}`);
    console.log("=".repeat(50));

    try {
        // 尝试加载已保存的 token
        let token = await loadToken();

        // 如果没有 token 或 token 过期，重新登录
        if (!token) {
            console.log("\n[步骤 1] 登录获取 Token");
            token = await login();

            if (!token) {
                console.error("\n✗ 无法获取有效的 Token");
                Deno.exit(1);
            }
        } else {
            console.log("\n[步骤 1] 使用已保存的 Token");
        }

        // 获取签到前的用户信息
        console.log("\n[步骤 2] 获取当前状态");
        let beforeInfo = await getUserInfo(token);

        // 如果 token 失效（401），重新登录
        if (beforeInfo.code === 401) {
            console.log("⚠ Token 已失效，重新登录...");
            token = await login();

            if (!token) {
                console.error("\n✗ 重新登录失败");
                Deno.exit(1);
            }

            beforeInfo = await getUserInfo(token);
        }

        if (beforeInfo.code === 200 && beforeInfo.data) {
            console.log("✓ 获取成功");
            console.log(`  用户名: ${beforeInfo.data.userInfo?.username || "未知"}`);
            console.log(`  当前积分: ${beforeInfo.data.userBalance?.sumModel3Count || 0}`);
        } else {
            console.error(`✗ 获取用户信息失败: ${beforeInfo.message || "未知错误"}`);
            Deno.exit(1);
        }

        // 执行签到
        console.log("\n[步骤 3] 执行签到");
        const signResult = await sign(token);

        if (signResult.code === 200 && signResult.success) {
            console.log(`✓ 签到成功: ${signResult.data || signResult.message}`);
        } else {
            console.log(`⚠ 签到响应: ${signResult.message || "未知状态"} (code: ${signResult.code})`);
        }

        // 获取签到后的用户信息
        console.log("\n[步骤 4] 获取最新状态");
        const afterInfo = await getUserInfo(token);

        if (afterInfo.code === 200 && afterInfo.data) {
            const oldPoints = beforeInfo.data?.userBalance?.sumModel3Count || 0;
            const newPoints = afterInfo.data.userBalance?.sumModel3Count || 0;
            const gained = newPoints - oldPoints;

            console.log("✓ 获取成功");
            console.log(`  签到后积分: ${newPoints}${gained > 0 ? ` (+${gained})` : gained < 0 ? ` (${gained})` : ""}`);
        }

        // 输出总结
        console.log("\n" + "=".repeat(50));
        console.log("✓ 签到流程完成");
        console.log("=".repeat(50));

    } catch (error) {
        console.error("\n" + "=".repeat(50));
        console.error("✗ 脚本执行出错:", error);
        console.error("=".repeat(50));
        Deno.exit(1);
    }
}

// 运行主函数
if (import.meta.main) {
    main();
}
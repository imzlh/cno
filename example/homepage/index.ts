// main.ts
import { Hono } from "npm:hono";
import { serveStatic } from "npm:hono/deno";

const app = new Hono();

// 数据存储文件路径
const DATA_FILE = "./data/submissions.json";

interface Submission {
  id: string;
  name: string;
  email: string;
  message: string;
  interests: unknown[];
  rating: number;
  timestamp: string;
}

// 确保数据目录存在
try {
  await Deno.mkdir("./data", { recursive: true });
} catch (error) {
  if (!(error instanceof Deno.errors.AlreadyExists)) {
    throw error;
  }
}

// 确保数据文件存在
try {
  await Deno.readTextFile(DATA_FILE);
} catch {
  await Deno.writeTextFile(DATA_FILE, JSON.stringify([], null, 2));
}

// 辅助函数：读写数据
async function readSubmissions(): Promise<Submission[]> {
  try {
    const data = await Deno.readTextFile(DATA_FILE);
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed as Submission[] : [];
  } catch (error) {
    console.error("读取数据失败:", error);
    return [];
  }
}

async function writeSubmissions(submissions: Submission[]) {
  try {
    await Deno.writeTextFile(DATA_FILE, JSON.stringify(submissions, null, 2));
    return true;
  } catch (error) {
    console.error("写入数据失败:", error);
    return false;
  }
}

// 静态文件服务
app.use("/static/*", serveStatic({ root: "./" }));
app.get("/", serveStatic({ path: "./index.html" }));

// API 路由
app.get("/api/submissions", async (c) => {
  try {
    const submissions = await readSubmissions();
    return c.json({
      success: true,
      data: submissions,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json(
      { success: false, error: "读取数据失败" },
      500
    );
  }
});

app.post("/api/submit", async (c) => {
  try {
    const body = await c.req.json() as Partial<Submission>;
    
    // 验证必需字段
    if (!body.name || !body.email) {
      return c.json(
        { success: false, error: "姓名和邮箱为必填项" },
        400
      );
    }
    
    const submissions = await readSubmissions();
    
    // 创建新的提交记录
    const newSubmission = {
      id: Date.now().toString(),
      name: body.name,
      email: body.email,
      message: body.message || "",
      interests: body.interests || [],
      rating: body.rating || 0,
      timestamp: new Date().toISOString(),
    };
    
    submissions.push(newSubmission);
    
    const success = await writeSubmissions(submissions);
    
    if (success) {
      return c.json({
        success: true,
        message: "提交成功！",
        data: newSubmission,
      });
    } else {
      return c.json(
        { success: false, error: "数据保存失败" },
        500
      );
    }
  } catch (error) {
    console.error("提交处理错误:", error);
    return c.json(
      { success: false, error: "服务器内部错误" },
      500
    );
  }
});

// 删除提交
app.delete("/api/submission/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const submissions = await readSubmissions();
    
    const initialLength = submissions.length;
    const filtered = submissions.filter((s) => s.id !== id);
    
    if (filtered.length === initialLength) {
      return c.json(
        { success: false, error: "未找到对应的提交记录" },
        404
      );
    }
    
    const success = await writeSubmissions(filtered);
    
    if (success) {
      return c.json({
        success: true,
        message: "删除成功",
        deletedId: id,
      });
    } else {
      return c.json(
        { success: false, error: "删除失败" },
        500
      );
    }
  } catch (error) {
    console.error("删除错误:", error);
    return c.json(
      { success: false, error: "服务器内部错误" },
      500
    );
  }
});

// 服务器信息
app.get("/api/info", (c) => {
  return c.json({
    server: "Hono + Deno 个人网站",
    version: "1.0.0",
    features: [
      "静态文件服务",
      "表单提交API",
      "数据存储",
      "花里胡哨的界面",
    ],
    endpoints: {
      GET: ["/", "/static/*", "/api/submissions", "/api/info"],
      POST: ["/api/submit"],
      DELETE: ["/api/submission/:id"],
    },
    timestamp: new Date().toISOString(),
  });
});

// 404 处理
app.notFound((c) => {
  return c.json(
    { success: false, error: "路由不存在" },
    404
  );
});

// 错误处理
app.onError((err, c) => {
  console.error("服务器错误:", err);
  return c.json(
    { success: false, error: "服务器内部错误" },
    500
  );
});

console.log("🚀 服务器启动在 http://localhost:8000");
console.log("📁 静态文件目录: ./static/");
console.log("💾 数据存储位置: ./data/submissions.json");

Deno.serve({ port: 8000 }, app.fetch);

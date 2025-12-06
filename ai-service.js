// ai-service.js

// 🚨 调试重点：这里我们加了 .trim() 防止复制时带入空格
const API_KEY = (process.env.SILICONFLOW_KEY || "sk-请在这里填入你的真实密钥").trim();

const HARD_RULES = {
    "游戏": ["英雄联盟", "原神", "csgo", "瓦罗兰特", "王者荣耀", "fps", "moba", "game", "黑神话", "steam"],
    "英雄联盟": ["游戏", "lol", "moba", "撸啊撸", "大乱斗"],
    "原神": ["游戏", "二次元", "米哈游", "开放世界"],
    "编程": ["写代码", "程序员", "前端", "后端", "js", "java", "node", "python"],
    "聊天": ["交友", "摸鱼", "随便", "唠嗑"]
};

// 初始化
async function initAI() {
    console.log("--------------- AI 服务启动检查 ---------------");
    console.log(`[Step 0] 检查 Key: ${API_KEY ? "已配置 (长度:" + API_KEY.length + ")" : "❌ 未配置"}`);
    if (API_KEY.startsWith("sk-请在这里")) {
        console.error("❌ 警告：你忘记把默认的提示文字改成真实的 Key 了！");
    }
    console.log("-----------------------------------------------");
}

// 获取向量 (略简写，重点查下面对话)
async function getVector(text) {
    if (!text) return null;
    try {
        const response = await fetch("https://api.siliconflow.cn/v1/embeddings", {
            method: "POST",
            headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "BAAI/bge-m3", input: text, encoding_format: "float" })
        });
        const data = await response.json();
        return data.data?.[0]?.embedding || null;
    } catch (e) { return null; }
}

// === 🚨 重点调试函数 ===
async function getAIChatReply(messagesHistory) {
    console.log("\n>>> [Step 1] 进入 getAIChatReply 函数");

    // 1. 检查 Key
    if (!API_KEY || API_KEY.startsWith("sk-请在这里")) {
        console.log("<<< [退出] 原因：Key 无效");
        return "（管理员未配置 AI Key）";
    }

    // 2. 准备数据
    const payload = {
        model: "Qwen/Qwen2.5-7B-Instruct", 
        messages: messagesHistory,
        max_tokens: 150,
        temperature: 0.8
    };
    console.log(`[Step 2] 准备发送请求，历史消息条数: ${messagesHistory.length}`);

    try {
        console.log("[Step 3] 正在通过 fetch 发送请求...");
        
        // 3. 发送请求
        const response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
            method: "POST",
            headers: { 
                "Authorization": `Bearer ${API_KEY}`, 
                "Content-Type": "application/json" 
            },
            body: JSON.stringify(payload)
        });

        console.log(`[Step 4] 收到响应状态码: ${response.status} (${response.statusText})`);

        // 4. 如果状态码不对，打印详细原因
        if (!response.ok) {
            const errText = await response.text();
            console.error("❌ [API 失败详情]:", errText); // <--- 这里一定要看！！！
            return "（大脑短路了...API报错）";
        }

        // 5. 解析数据
        const data = await response.json();
        console.log("[Step 5] JSON 解析成功");

        if (!data.choices || data.choices.length === 0) {
            console.error("❌ [数据异常] 返回的 choices 为空:", data);
            return "（大脑一片空白...）";
        }

        const reply = data.choices[0].message.content;
        console.log(`<<< [成功] AI 回复: "${reply.substring(0, 10)}..."`);
        return reply;

    } catch (e) {
        console.error("❌ [代码/网络 严重崩溃]:", e);
        return "（网络连接断开了）";
    }
}

// 匹配逻辑 (保持不变)
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB) return 0;
    const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const mA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const mB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    return mA === 0 || mB === 0 ? 0 : dot / (mA * mB);
}

function calculateMatch(keywordA, keywordB, vecA, vecB) {
    const k1 = keywordA.toLowerCase();
    const k2 = keywordB.toLowerCase();
    if (k1.includes(k2) || k2.includes(k1)) return { score: 0.99, type: 'rule' };
    for (let key in HARD_RULES) {
        const list = HARD_RULES[key];
        if ((k1 === key && list.includes(k2)) || (k2 === key && list.includes(k1)) || (list.includes(k1) && list.includes(k2))) return { score: 0.99, type: 'rule' };
    }
    if (vecA && vecB) return { score: cosineSimilarity(vecA, vecB), type: 'ai' };
    return { score: 0, type: 'none' };
}

module.exports = { initAI, getVector, calculateMatch, getAIChatReply };
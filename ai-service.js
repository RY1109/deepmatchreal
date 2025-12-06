// ai-service.js
const API_KEY = process.env.SILICONFLOW_KEY; // 确保 Render 环境变量已配置

const HARD_RULES = {
    "游戏": ["英雄联盟", "原神", "csgo", "瓦罗兰特", "王者荣耀", "fps", "moba", "game", "黑神话"],
    "英雄联盟": ["游戏", "lol", "moba", "撸啊撸", "大乱斗"],
    "原神": ["游戏", "二次元", "米哈游", "开放世界"],
    "编程": ["写代码", "程序员", "前端", "后端", "js", "java"]
};

async function initAI() {
    console.log("☁️ 已连接 SiliconFlow (Qwen2.5-72B 旗舰版)...");
}

// 1. 获取向量 (保持不变)
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

// 2. 【核心修改】获取 AI 回复 (支持上下文记忆)
// messages 参数现在是一个数组：[{role: 'user', content: '...'}, ...]
async function getAIChatReply(messagesHistory) {
    try {
        const response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
            method: "POST",
            headers: { 
                "Authorization": `Bearer ${API_KEY}`, 
                "Content-Type": "application/json" 
            },
            body: JSON.stringify({
                // 🔥 升级为 72B 模型，目前最强的中文开源模型，说话极其自然
                model: "Qwen/Qwen2.5-7B-Instruct", 
                messages: messagesHistory, // 把整个聊天记录发过去
                max_tokens: 150, // 允许回复稍微长一点
                temperature: 0.9, // 0.9 比较高，会让回复更有趣、不重复
                top_p: 0.9
            })
        });

        const data = await response.json();
        if (!data.choices) {
            console.error("AI 接口返回异常:", data);
            return "（对方正在思考...）";
        }
        return data.choices[0].message.content;

    } catch (e) {
        console.error("AI 接口报错:", e);
        return "网络波动了一下...";
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
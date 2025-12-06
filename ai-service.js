// ai-service.js
const API_KEY = process.env.SILICONFLOW_KEY; // 确保 Render 环境变量里配置了

// 硬规则 (保持不变)
const HARD_RULES = {
    "游戏": ["英雄联盟", "原神", "csgo", "瓦罗兰特", "王者荣耀", "fps", "moba", "game", "黑神话"],
    "英雄联盟": ["游戏", "lol", "moba", "撸啊撸", "大乱斗"],
    "原神": ["游戏", "二次元", "米哈游", "开放世界"],
    "编程": ["写代码", "程序员", "前端", "后端", "js", "java"]
};

// 初始化
async function initAI() {
    console.log("☁️ AI 服务已连接 (SiliconFlow)");
}

// 1. 获取向量 (用于匹配，保持不变)
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
    } catch (e) { console.error("向量接口出错:", e); return null; }
}

// 2. 【新增】获取 AI 回复 (用于陪聊)
// 使用免费且强大的 Qwen/Qwen2.5-7B-Instruct 模型
async function getAIChatReply(message, topic) {
    try {
        const response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "Qwen/Qwen2.5-7B-Instruct", // 选用通义千问开源版，速度快，中文好
                messages: [
                    { 
                        role: "system", 
                        content: `你现在正在一个匿名聊天室里扮演一位真实用户。
                        你的当前兴趣话题是"${topic}"。
                        请遵循以下规则：
                        1. 说话要简短、口语化，像个真实的网友，不要像机器人。
                        2. 多围绕当前兴趣话题进行聊天，表现出兴趣和热情。
                        3. 遇到敏感话题要巧妙转移话题。
                        4. 严禁暴露自己是AI。
                        5. 回复中不要包含任何AI、机器人等字眼。
                        6. 回复中不要包含任何广告、推广等内容。
                        7.不要出现重复的回复。` 
                    },
                    { role: "user", content: message }
                ],
                max_tokens: 100, // 回复不要太长
                temperature: 0.7 // 增加一点随机性
            })
        });
        const data = await response.json();
        return data.choices?.[0]?.message?.content || "哈哈，不知道怎么回你了";
    } catch (e) {
        console.error("AI 对话接口出错:", e);
        return "网络有点卡，等会聊~";
    }
}

// 匹配计算 (保持不变)
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
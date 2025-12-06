// ai-service.js

// 你的 API Key
const API_KEY = process.env.SILICONFLOW_KEY || "sk-请在这里填入你的真实密钥"; 

const HARD_RULES = {
    "游戏": ["英雄联盟", "原神", "csgo", "瓦罗兰特", "王者荣耀", "fps", "moba", "game", "黑神话", "steam"],
    "英雄联盟": ["游戏", "lol", "moba", "撸啊撸", "大乱斗"],
    "原神": ["游戏", "二次元", "米哈游", "开放世界"],
    "编程": ["写代码", "程序员", "前端", "后端", "js", "java", "node", "python"],
    "聊天": ["交友", "摸鱼", "随便", "唠嗑"]
};

// === 备用模型列表 (按优先顺序) ===
const BACKUP_MODELS = [
    "Qwen/Qwen2.5-7B-Instruct", // 首选：最新版 7B
    "Qwen/Qwen2-7B-Instruct",   // 备选1：老版 7B (通常比较空)
    "THUDM/chatglm3-6b",        // 备选2：智谱 6B (非常稳定)
    "01-ai/Yi-1.5-6B-Chat"      // 备选3：零一万物 6B
];

async function initAI() {
    console.log("☁️ AI 服务已就绪 (支持自动故障转移)");
}

// 向量获取 (保持不变)
async function getVector(text) {
    if (!text) return null;
    try {
        // 向量模型比较稳定，一般不需要切换，如果 bge-m3 挂了可以用 bge-large-zh
        const response = await fetch("https://api.siliconflow.cn/v1/embeddings", {
            method: "POST",
            headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "BAAI/bge-m3", input: text, encoding_format: "float" })
        });
        const data = await response.json();
        return data.data?.[0]?.embedding || null;
    } catch (e) { return null; }
}

// === 核心修改：支持自动切换模型的聊天函数 ===
async function getAIChatReply(messagesHistory) {
    if (!API_KEY || API_KEY.startsWith("sk-请在这里")) return "（Key配置错误）";

    // 循环尝试备用模型列表
    for (const modelName of BACKUP_MODELS) {
        try {
            console.log(`🤖 尝试使用模型: ${modelName} ...`);
            
            const response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
                method: "POST",
                headers: { 
                    "Authorization": `Bearer ${API_KEY}`, 
                    "Content-Type": "application/json" 
                },
                body: JSON.stringify({
                    model: modelName, // 动态使用当前尝试的模型
                    messages: messagesHistory,
                    max_tokens: 150,
                    temperature: 0.8
                })
            });

            // 如果是 503 (服务繁忙) 或 429 (限流)，则抛出错误进入 catch，尝试下一个
            if (response.status === 503 || response.status === 429) {
                console.warn(`⚠️ 模型 ${modelName} 繁忙 (Status ${response.status})，尝试切换下一个...`);
                continue; // 跳过当前循环，试下一个
            }

            if (!response.ok) {
                const err = await response.text();
                console.error(`❌ 模型 ${modelName} 报错:`, err);
                break; // 如果是其他错误(如Key错)，不用试了，直接退出
            }

            const data = await response.json();
            const reply = data.choices?.[0]?.message?.content;
            if (reply) {
                console.log(`✅ 成功使用 ${modelName} 回复`);
                return reply;
            }

        } catch (e) {
            console.error(`❌ 网络错误 (${modelName}):`, e.message);
        }
    }

    // 如果所有模型都试完了还在报错
    return "（所有 AI 都在忙，请稍等几秒再发...）";
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
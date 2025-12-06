// ai-service.js

// ==============================================================================
// 1. 配置区域
// 在本地测试时，你可以把 Key 填在 || 后面
// 在 Render 部署时，请在后台 Environment Variables 里设置 SILICONFLOW_KEY
// ==============================================================================
const API_KEY = process.env.SILICONFLOW_KEY || "sk-请在这里填入你的真实密钥";

// 硬规则字典 (保持不变，用于 100% 精准匹配)
const HARD_RULES = {
    "游戏": ["英雄联盟", "原神", "csgo", "瓦罗兰特", "王者荣耀", "fps", "moba", "game", "黑神话", "steam"],
    "英雄联盟": ["游戏", "lol", "moba", "撸啊撸", "大乱斗"],
    "原神": ["游戏", "二次元", "米哈游", "开放世界"],
    "编程": ["写代码", "程序员", "前端", "后端", "js", "java", "node", "python"],
    "聊天": ["交友", "摸鱼", "随便", "唠嗑"]
};

// 初始化 (API 模式不需要加载大文件)
async function initAI() {
    if (!API_KEY || API_KEY.startsWith("sk-请在这里")) {
        console.warn("⚠️ 警告: 未检测到有效的 API Key，AI 功能可能无法使用！");
    } else {
        console.log("☁️ 已连接 SiliconFlow 云端 AI 服务");
    }
}

// === 功能 1: 获取向量 (用于匹配) ===
// 使用模型: BAAI/bge-m3 (目前最强中文语义向量)
async function getVector(text) {
    if (!text) return null;
    try {
        const response = await fetch("https://api.siliconflow.cn/v1/embeddings", {
            method: "POST",
            headers: { 
                "Authorization": `Bearer ${API_KEY}`, 
                "Content-Type": "application/json" 
            },
            body: JSON.stringify({
                model: "BAAI/bge-m3", 
                input: text, 
                encoding_format: "float"
            })
        });

        if (!response.ok) {
            console.error("向量 API 报错:", response.status, await response.text());
            return null;
        }

        const data = await response.json();
        return data.data?.[0]?.embedding || null;
    } catch (e) {
        console.error("向量接口网络错误:", e.message);
        return null;
    }
}

// === 功能 2: 获取 AI 陪聊回复 ===
// 使用模型: Qwen/Qwen2.5-7B-Instruct (速度快、免费、效果好)
async function getAIChatReply(messagesHistory) {
    // 如果没有 Key，直接返回假装思考
    if (!API_KEY || API_KEY.startsWith("sk-请在这里")) return "（管理员未配置 AI Key...）";

    try {
        const response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
            method: "POST",
            headers: { 
                "Authorization": `Bearer ${API_KEY}`, 
                "Content-Type": "application/json" 
            },
            body: JSON.stringify({
                model: "Qwen/Qwen2.5-7B-Instruct", // 7B 模型响应只需 1-2 秒，适合即时聊天
                messages: messagesHistory,          // 把聊天记录(上下文)传过去
                max_tokens: 150,                    // 限制回复长度
                temperature: 0.8,                   // 0.8 比较活跃，0.2 比较死板
                top_p: 0.9
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error("对话 API 报错:", response.status, errText);
            
            // 针对余额不足的特殊处理
            if (response.status === 402 || errText.includes("balance")) {
                return "（我的算力耗尽了，老板忘记充值了...）";
            }
            return "（大脑短路了，请稍后再试）";
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content || "...";

    } catch (e) {
        console.error("对话接口网络错误:", e.message);
        return "（网络信号不好，断线了...）";
    }
}

// === 功能 3: 匹配算法 (纯数学计算) ===
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
    
    // 1. 硬规则优先
    if (k1.includes(k2) || k2.includes(k1)) return { score: 0.99, type: 'rule' };
    for (let key in HARD_RULES) {
        const list = HARD_RULES[key];
        if ((k1 === key && list.includes(k2)) || 
            (k2 === key && list.includes(k1)) || 
            (list.includes(k1) && list.includes(k2))) {
            return { score: 0.99, type: 'rule' };
        }
    }

    // 2. AI 向量匹配
    if (vecA && vecB) {
        const score = cosineSimilarity(vecA, vecB);
        return { score: score, type: 'ai' };
    }

    return { score: 0, type: 'none' };
}

module.exports = { initAI, getVector, calculateMatch, getAIChatReply };
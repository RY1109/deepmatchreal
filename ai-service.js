// ai-service.js
const HARD_RULES = {
    "游戏": ["英雄联盟", "原神", "csgo", "瓦罗兰特", "王者荣耀", "fps", "moba", "game", "黑神话"],
    "英雄联盟": ["游戏", "lol", "moba", "撸啊撸", "大乱斗"],
    "原神": ["游戏", "二次元", "米哈游", "开放世界"],
    "编程": ["写代码", "程序员", "前端", "后端", "js", "java"]
};

let extractor = null;

// 初始化 AI
async function initAI() {
    console.log("🛠️ 正在加载 BGE 中文模型...");
    const { pipeline } = await import('@xenova/transformers');
    extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5');
    console.log("✅ BGE 模型加载完成");
}

// 计算向量
async function getVector(text) {
    if (!extractor) return null;
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

// 余弦相似度
function cosineSimilarity(vecA, vecB) {
    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const mA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const mB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    return mA === 0 || mB === 0 ? 0 : dotProduct / (mA * mB);
}

// 核心匹配逻辑
function calculateMatch(keywordA, keywordB, vecA, vecB) {
    // 1. 硬规则检查
    const k1 = keywordA.toLowerCase();
    const k2 = keywordB.toLowerCase();
    
    // 直接包含
    if (k1.includes(k2) || k2.includes(k1)) return { score: 0.99, type: 'rule' };

    // 字典匹配
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

module.exports = { initAI, getVector, calculateMatch };
/**
 * Token 估算模块
 * 支持中英文混合文本、代码、JSON 格式的估算
 */

// 字符类型权重配置
const CHAR_WEIGHTS = {
  chinese: 1.5,    // 中文字符权重（通常 1 个中文字 ≈ 1.5 token）
  english: 0.25,   // 英文字符权重（通常 4 个英文字符 ≈ 1 token）
  code: 0.3,       // 代码字符权重（代码通常比普通文本更紧凑）
  json: 0.25,      // JSON 字符权重（JSON 结构有重复模式）
  whitespace: 0.1  // 空白字符权重（空格、换行等）
};

// 正则表达式模式
const PATTERNS = {
  chinese: /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g,
  english: /[a-zA-Z0-9]/g,
  code: /[{}\[\]();:.,=+\-*/<>!&|^~%]/g,
  json: /"[^"]*":/g,
  whitespace: /\s+/g
};

/**
 * 估算单个字符的 token 数
 * @param {string} char - 单个字符
 * @returns {number} 估算的 token 数
 */
function estimateCharTokens(char) {
  if (PATTERNS.chinese.test(char)) {
    return CHAR_WEIGHTS.chinese;
  }
  if (PATTERNS.english.test(char)) {
    return CHAR_WEIGHTS.english;
  }
  if (PATTERNS.code.test(char)) {
    return CHAR_WEIGHTS.code;
  }
  if (PATTERNS.whitespace.test(char)) {
    return CHAR_WEIGHTS.whitespace;
  }
  return 0.25; // 默认权重
}

/**
 * 估算文本的 token 数
 * @param {string} text - 要估算的文本
 * @returns {number} 估算的 token 数
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  
  let tokens = 0;
  
  // 统计中文字符
  const chineseMatches = text.match(PATTERNS.chinese);
  const chineseCount = chineseMatches ? chineseMatches.length : 0;
  tokens += chineseCount * CHAR_WEIGHTS.chinese;
  
  // 统计英文字符
  const englishMatches = text.match(PATTERNS.english);
  const englishCount = englishMatches ? englishMatches.length : 0;
  tokens += englishCount * CHAR_WEIGHTS.english;
  
  // 统计代码字符
  const codeMatches = text.match(PATTERNS.code);
  const codeCount = codeMatches ? codeMatches.length : 0;
  tokens += codeCount * CHAR_WEIGHTS.code;
  
  // 统计空白字符
  const whitespaceMatches = text.match(PATTERNS.whitespace);
  const whitespaceCount = whitespaceMatches ? whitespaceMatches.join('').length : 0;
  tokens += whitespaceCount * CHAR_WEIGHTS.whitespace;
  
  // 统计 JSON 键（如果有）
  const jsonKeyMatches = text.match(PATTERNS.json);
  const jsonKeyCount = jsonKeyMatches ? jsonKeyMatches.length : 0;
  tokens += jsonKeyCount * 0.5; // JSON 键额外开销
  
  return Math.ceil(tokens);
}

/**
 * 估算消息数组的 token 数
 * @param {Array} messages - 消息数组
 * @returns {number} 估算的 token 数
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  
  let totalTokens = 0;
  
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    
    // 角色 token
    totalTokens += 4; // 角色标签开销
    
    // 内容 token
    if (typeof message.content === 'string') {
      totalTokens += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text' && part.text) {
          totalTokens += estimateTokens(part.text);
        }
      }
    }
    
    // 工具调用 token
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        totalTokens += estimateTokens(JSON.stringify(toolCall));
      }
    }
  }
  
  return totalTokens;
}

/**
 * 估算整个请求的 token 数
 * @param {Object} chatRequest - Chat Completions 请求对象
 * @returns {number} 估算的 token 数
 */
export function estimateRequestTokens(chatRequest) {
  if (!chatRequest || typeof chatRequest !== 'object') return 0;
  
  let totalTokens = 0;
  
  // 模型 token（通常很小）
  totalTokens += 10;
  
  // 消息 token
  totalTokens += estimateMessagesTokens(chatRequest.messages);
  
  // 工具 token
  if (chatRequest.tools) {
    for (const tool of chatRequest.tools) {
      totalTokens += estimateTokens(JSON.stringify(tool));
    }
  }
  
  return totalTokens;
}

/**
 * 获取 Token 估算统计信息
 * @param {string} text - 要估算的文本
 * @returns {Object} 统计信息
 */
export function getTokenStats(text) {
  if (!text || typeof text !== 'string') {
    return {
      totalTokens: 0,
      chineseTokens: 0,
      englishTokens: 0,
      codeTokens: 0,
      whitespaceTokens: 0,
      charCount: 0
    };
  }
  
  const chineseMatches = text.match(PATTERNS.chinese);
  const englishMatches = text.match(PATTERNS.english);
  const codeMatches = text.match(PATTERNS.code);
  const whitespaceMatches = text.match(PATTERNS.whitespace);
  
  const chineseCount = chineseMatches ? chineseMatches.length : 0;
  const englishCount = englishMatches ? englishMatches.length : 0;
  const codeCount = codeMatches ? codeMatches.length : 0;
  const whitespaceCount = whitespaceMatches ? whitespaceMatches.join('').length : 0;
  
  return {
    totalTokens: estimateTokens(text),
    chineseTokens: Math.ceil(chineseCount * CHAR_WEIGHTS.chinese),
    englishTokens: Math.ceil(englishCount * CHAR_WEIGHTS.english),
    codeTokens: Math.ceil(codeCount * CHAR_WEIGHTS.code),
    whitespaceTokens: Math.ceil(whitespaceCount * CHAR_WEIGHTS.whitespace),
    charCount: text.length
  };
}
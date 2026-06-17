/**
 * 对话管理器 - 支持有状态对话
 * 使用内存存储对话历史，支持 LRU 清理策略
 */
export class ConversationManager {
  constructor(maxSize = 1000, ttlMs = 3600000) {
    this.conversations = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * 获取对话
   * @param {string} id - 对话 ID
   * @returns {Object|null} 对话对象或 null
   */
  getConversation(id) {
    const conv = this.conversations.get(id);
    if (!conv) return null;
    
    // 检查是否过期
    if (Date.now() - conv.lastAccess > this.ttlMs) {
      this.conversations.delete(id);
      return null;
    }
    
    // 更新访问时间
    conv.lastAccess = Date.now();
    return conv;
  }

  /**
   * 创建新对话
   * @param {Array} messages - 初始消息列表
   * @returns {string} 对话 ID
   */
  createConversation(messages) {
    const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.conversations.set(id, {
      id,
      messages: [...messages], // 复制消息列表
      lastAccess: Date.now()
    });
    
    this.cleanup();
    return id;
  }

  /**
   * 添加消息到对话
   * @param {string} conversationId - 对话 ID
   * @param {Object} message - 消息对象
   * @returns {boolean} 是否成功添加
   */
  addMessage(conversationId, message) {
    const conv = this.getConversation(conversationId);
    if (!conv) return false;
    
    conv.messages.push(message);
    return true;
  }

  /**
   * 获取对话中的所有消息
   * @param {string} conversationId - 对话 ID
   * @returns {Array} 消息列表
   */
  getMessages(conversationId) {
    const conv = this.getConversation(conversationId);
    return conv ? [...conv.messages] : [];
  }

  /**
   * 清理过期对话
   */
  cleanup() {
    if (this.conversations.size <= this.maxSize) return;
    
    // 按访问时间排序，删除最旧的对话
    const entries = [...this.conversations.entries()]
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    
    const toDelete = entries.slice(0, entries.length - this.maxSize);
    for (const [id] of toDelete) {
      this.conversations.delete(id);
    }
  }

  /**
   * 获取对话统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      totalConversations: this.conversations.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs
    };
  }
}

// 创建默认实例
export const defaultConversationManager = new ConversationManager();
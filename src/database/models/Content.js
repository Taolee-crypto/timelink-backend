export class Content {
  constructor(db) {
    this.db = db;
  }
  
  async create(contentData) {
    const { 
      userId, 
      title, 
      description, 
      fileUrl, 
      fileType, 
      duration, 
      thumbnailUrl,
      price,
      category
    } = contentData;
    
    const result = await this.db.prepare(
      `INSERT INTO content 
       (user_id, title, description, file_url, file_type, duration, thumbnail_url, price, category, created_at, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      userId, 
      title, 
      description, 
      fileUrl, 
      fileType, 
      duration, 
      thumbnailUrl,
      price || 0,
      category || 'general',
      new Date().toISOString(),
      'active'
    ).run();
    
    return result.lastRowId;
  }
  
  async findById(id) {
    return await this.db.prepare(
      `SELECT c.*, u.username as owner_username 
       FROM content c 
       JOIN users u ON c.user_id = u.id 
       WHERE c.id = ? AND c.status = 'active'`
    ).bind(id).first();
  }
  
  async findByUserId(userId, limit = 20, offset = 0) {
    return await this.db.prepare(
      `SELECT * FROM content 
       WHERE user_id = ? AND status = 'active' 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`
    ).bind(userId, limit, offset).all();
  }
  
  async updateStatus(id, status) {
    return await this.db.prepare(
      'UPDATE content SET status = ? WHERE id = ?'
    ).bind(status, id).run();
  }
}

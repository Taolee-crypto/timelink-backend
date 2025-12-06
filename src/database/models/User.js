export class User {
  constructor(db) {
    this.db = db;
  }
  
  async create(userData) {
    const { email, password, username } = userData;
    const result = await this.db.prepare(
      'INSERT INTO users (email, password, username, created_at) VALUES (?, ?, ?, ?)'
    ).bind(email, password, username, new Date().toISOString()).run();
    
    return result.lastRowId;
  }
  
  async findByEmail(email) {
    return await this.db.prepare(
      'SELECT * FROM users WHERE email = ?'
    ).bind(email).first();
  }
  
  async findById(id) {
    return await this.db.prepare(
      'SELECT id, email, username, balance, created_at FROM users WHERE id = ?'
    ).bind(id).first();
  }
  
  async updateBalance(id, amount) {
    return await this.db.prepare(
      'UPDATE users SET balance = balance + ? WHERE id = ?'
    ).bind(amount, id).run();
  }
}

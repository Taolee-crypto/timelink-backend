import { User } from '../database/models/User.js';

export class AuthService {
  constructor(db) {
    this.userModel = new User(db);
  }
  
  async register(userData) {
    const existingUser = await this.userModel.findByEmail(userData.email);
    if (existingUser) {
      throw new Error('Email already registered');
    }
    
    const userId = await this.userModel.create(userData);
    return { userId, success: true };
  }
  
  async login(email, password) {
    const user = await this.userModel.findByEmail(email);
    
    if (!user) {
      throw new Error('Invalid credentials');
    }
    
    // 실제 구현에서는 bcrypt.compare 사용
    if (password !== user.password) {
      throw new Error('Invalid credentials');
    }
    
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      balance: user.balance || 0
    };
  }
  
  async getUserProfile(userId) {
    return await this.userModel.findById(userId);
  }
}

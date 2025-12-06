import { describe, it, expect, beforeEach } from 'vitest';
import { AuthService } from '../../src/services/auth.service.js';

describe('AuthService', () => {
  let authService;
  let mockDb;
  
  beforeEach(() => {
    mockDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          run: async () => ({ lastRowId: 1 })
        })
      })
    };
    authService = new AuthService(mockDb);
  });
  
  it('should register a new user', async () => {
    const userData = {
      email: 'test@example.com',
      password: 'password123',
      username: 'testuser'
    };
    
    const result = await authService.register(userData);
    expect(result.success).toBe(true);
    expect(result.userId).toBe(1);
  });
  
  it('should throw error for duplicate email', async () => {
    mockDb.prepare = () => ({
      bind: () => ({
        first: async () => ({ id: 1, email: 'test@example.com' })
      })
    });
    
    const userData = {
      email: 'test@example.com',
      password: 'password123',
      username: 'testuser'
    };
    
    await expect(authService.register(userData)).rejects.toThrow('Email already registered');
  });
});

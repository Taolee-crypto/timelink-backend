export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ENVIRONMENT: string;
}

export interface JWTPayload {
  sub: string;  // user id
  exp: number;
}

export interface User {
  id: number;
  email: string;
  username: string;
  password_hash: string;
  tl_balance: number;
  tl_locked: number;
  tlc_balance: number;
  total_tl_spent: number;
  total_tl_earned: number;
  total_tl_exchanged: number;
  poc_index: number;
  false_dispute_strikes: number;
  account_forfeited: number;
  tl_suspended: number;
  is_active: number;
  created_at: string;
}

export interface TLFile {
  id: number;
  user_id: number;
  title: string;
  artist: string;
  genre: string;
  country: string;
  file_type: string;
  file_url: string;
  file_tl: number;
  max_file_tl: number;
  revenue: number;
  hold_revenue: number;
  auth_status: string;
  auth_type: string;
  shared: number;
  pulse: number;
  play_count: number;
  revenue_held: number;
  created_at: string;
  updated_at: string;
}

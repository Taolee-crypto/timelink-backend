export interface R2BucketBinding {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<unknown>;
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    body: ReadableStream | null;
  } | null>;
  delete(key: string): Promise<void>;
}

export interface Env {
  DB: D1Database;
  // Optional until billing is enabled. Keep the R2 integration typed and ready.
  R2?: R2BucketBinding;
  JWT_SECRET: string;
  RESEND_API_KEY: string;
  ENVIRONMENT: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  ONEDRIVE_CLIENT_ID?: string;
  ONEDRIVE_CLIENT_SECRET?: string;
  ONEDRIVE_REDIRECT_URI?: string;
  STORAGE_ENCRYPTION_KEY?: string;
  TL_SECRET?: string;
  TL3_MASTER_SECRET?: string;
  UNSPLASH_ACCESS_KEY?: string;
  KAKAO_REST_API_KEY?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
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

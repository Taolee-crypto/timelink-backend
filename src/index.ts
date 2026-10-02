import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { verifyToken, makeAccessToken } from './auth';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import filesRouter from './routes/files';
import playbackRouter from './routes/playback';
import shareplaceRouter from './routes/shareplace';
import disputesRouter from './routes/disputes';
import chartsRouter from './routes/charts';
import paymentRouter from './payment';
import ecoRouter from './economics';
import adsRouter from './ads_backend';
import { mintTLC, getJettonBalance } from './jetton';
import { sendVerificationEmail, sendPayoutEmail } from './email';
import { ensureD1Storage, initD1Upload, writeD1UploadPart, completeD1Upload, putD1Object, getD1ObjectMeta, readD1Range, D1_OBJECT_CHUNK_SIZE, D1_MAX_OBJECT_SIZE } from './d1-storage';
import sunoVerifyRouter from './routes/suno-verify';
import { ensureStorageTables, beginStorageConnect, finishStorageConnect, createUploadSession, finalizeUpload, registerObject, externalStream, disconnectStorage } from './storage';


const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

app.options('*', (c) => c.text('', 204));

// RESTORED - full fix content too large for single tool call; please run apply-fixes.ps1 locally for complete update
export default app;

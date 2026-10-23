# TILO server broadcast timeline (phase 1)
Endpoint: `GET /api/v1/central-broadcast-v5/country/KR/now?admin_id=...` (router prefix depends on mount), authenticated with `X-Central-Broadcast-Secret`.
Returns serverTime, country timezone, local show, and deterministic current track/position. No always-running PC, Cron, or per-minute D1 writes required.
The playlist is derived from currently active explicit service and broadcast-rights grants. As grants change, the computed cycle can change. Production playout must use a **persisted versioned schedule** to avoid discontinuities; this initial clock is not yet a stable live radio station.
The current browser player does not yet consume this endpoint. No server-side audio stream, DJ TTS, or listener sync is claimed.
No payments are posted by the clock. TL3 V5 security and existing 0.3 x 7:3 settlement remain unchanged.

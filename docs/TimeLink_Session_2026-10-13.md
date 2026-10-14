\# TimeLink Session — 2026-10-13



\## ✅ 완료된 작업



\### 1. TLD 코어 (원칙 1\~6)

\- \*\*TLD 컨테이너\*\* (원칙 5): `timelink-score/src/timelink\_score/tld/container.py`

\- \*\*스파인 체인\*\* (원칙 2): `crypto.py` — T\_0→T\_N, AES-256-GCM

\- \*\*저작권자 AAD\*\* (원칙 6): 헤더 + AAD + XMP

\- \*\*PDF 렌더\*\*: LilyPond → 페이지별 분할

\- \*\*FastAPI 서버\*\*: `tld/server.py` (포트 8000)

\- \*\*CLI\*\*: `tld build/meta/page/print/analyze`



\### 2. Cloudflare Tunnel (2개 활성)

| 터널 | ID | 도메인 | 서비스 |

|------|-----|--------|--------|

| timelink-agent | `fdbf2457-...` | agent.timelink.digital | 8787 (오디오) |

| timelink-tld | `db3c66af-...` | tld.timelink.digital | 8000 (TLD) |



\### 3. Workers 프록시 (커밋 e5e9474)

\- `timelink-backend/src/routes/score.ts`

\- `/api/v1/scores/:shareId/file.tld` → `https://score.timelink.digital`

\- `types.ts`에 `TLD\_SERVER\_URL?` 추가



\### 4. TRACK.HTML PDF 버튼 (커밋 80a29d9)

\- 악보 모달에 "PDF 악보" 버튼

\- `downloadTldPdf()` 함수 → Workers 프록시 경유



\### 5. 실제 곡 TLD 검증

\- `sh\_1791770652897\_fwm8n` (Just Let Yourself Cry)

\- TLD 생성 → D1 저장 → TRACK 열람 성공



\### 6. 분석 최적화 4.5배 (커밋 dbee55d)

| 단계 | 이전 | 현재 |

|------|------|------|

| 조성 (chroma\_cqt→stft) | 12.6s | \~3s |

| 멜로디 (pyin→yin) | 51.4s | \~15s |

| 코드 (cqt→stft) | 1.5s | 1.5s |

| \*\*총\*\* | \*\*89s\*\* | \*\*20s\*\* |



\### 7. 백그라운드 분석 통합 (커밋 c21e246)

\- `timelink-frontend/local-agent/server.js`

\- `/upload` 시 `analyzeInBackground()` spawn

\- `/analysis/:token` 엔드포인트



\### 8. 복사 감지 워터마크 (커밋 bbf378e)

\- `watermark.py`: `embed\_copy\_detection` (5중 레이어)



\---



\## 🚧 진행 중 문제



\### 1. C 드라이브 용량 부족

\- \*\*C: 145GB 중 여유 16GB\*\*

\- \*\*AppData\\Local이 대부분 차지\*\*

\- \*\*다음\*\*: AppData\\Local 상위 20개 폴더 확인 후 정리



\### 2. 가사 악보 붙이기

\- Whisper CPU 너무 느림 (medium 5분+)

\- \*\*수동 입력으로 전환 예정\*\*

\- `creator.html` lyricsInput textarea

\- 백엔드 `lyrics\_text` 저장



\---



\## 📂 레포 경로



| 레포 | 경로 |

|------|------|

| timelink-score | `C:\\Users\\win11\\Desktop\\timelink-score` |

| timelink-backend | `C:\\Users\\win11\\Desktop\\timelink-backend` |

| timelink-frontend | `C:\\Users\\win11\\Desktop\\timelink-frontend` |



\---



\## 🔧 활성 프로세스



\- \*\*PM2\*\*: `timelink-agent` (8787)

\- \*\*cloudflared\*\* 2개

\- \*\*Python FastAPI\*\* (포트 8000)



\---



\## 🎯 새 창에서 할 일



\### 1️⃣ C 용량 늘ㄹㅣ기

```powershell

$path = "C:\\Users\\win11\\AppData\\Local"

Get-ChildItem $path -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {

&#x20;   $size = 0

&#x20;   \[System.IO.Directory]::EnumerateFiles($\_.FullName, "\*", \[System.IO.SearchOption]::AllDirectories) | ForEach-Object {

&#x20;       try { $size += (New-Object System.IO.FileInfo $\_).Length } catch {}

&#x20;   }

&#x20;   \[PSCustomObject]@{ Name = $\_.Name; Size\_GB = \[math]::Round($size/1GB, 2) }

} | Sort-Object Size\_GB -Descending | Select-Object -First 20 | Format-Table


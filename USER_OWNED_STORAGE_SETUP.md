# TimeLink 사용자 소유 저장소 설정

TimeLink는 크리에이터의 원본 파일을 자체 저장소에 보관하지 않고, 크리에이터가 연결한 개인 저장소를 파일의 실제 저장 위치로 사용한다.

현재 지원:
- Google Drive — `drive.file` 최소 권한
- Microsoft OneDrive — `Files.ReadWrite.AppFolder` 앱 폴더 권한
- TimeLink Local Agent — 개인 PC/NAS 방식

## 1. Cloudflare Worker secret

다음 secret은 반드시 설정한다.

```powershell
npx wrangler secret put JWT_SECRET
npx wrangler secret put STORAGE_ENCRYPTION_KEY
```

`STORAGE_ENCRYPTION_KEY`는 긴 무작위 문자열을 사용한다. OAuth access/refresh token은 AES-GCM으로 암호화되어 D1에 저장된다.

## 2. Google Drive

Google Cloud에서 OAuth 2.0 Web application client를 만든다.

Redirect URI:
```
https://api.timelink.digital/api/storage/oauth/google_drive/callback
```

필요한 환경값:

```powershell
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
```

또는 client ID는 `wrangler.toml [vars]`에 둘 수 있다.

Drive scope는 `https://www.googleapis.com/auth/drive.file`만 사용한다. TimeLink가 만든 파일과 TimeLink 폴더만 다루는 구조이다.

## 3. OneDrive

Microsoft Entra App Registration을 만들고 redirect URI를 등록한다.

Redirect URI:
```
https://api.timelink.digital/api/storage/oauth/onedrive/callback
```

권한:
```
Files.ReadWrite.AppFolder
offline_access
openid
profile
```

필요한 값:

```powershell
npx wrangler secret put ONEDRIVE_CLIENT_SECRET
npx wrangler secret put ONEDRIVE_CLIENT_ID
```

OneDrive에서는 앱 전용 `approot` 폴더를 사용한다.

## 4. 배포

```powershell
cd "$env:USERPROFILE\Desktop\timelink-backend"
git pull --ff-only
Set-ExecutionPolicy -Scope Process Bypass
.\deploy-cloudflare.ps1
```

## 5. 동작 구조

```
크리에이터 브라우저
       │
       ├─ OAuth ──────────────> Google Drive / OneDrive
       │
       ├─ TL3 변환
       │
       └─ resumable upload ──> 개인 클라우드
                                  │
                                  ▼
                           실제 파일 보관
                                  │
TimeLink D1 <─────────────────────┘
  ├─ 사용자/권리 정보
  ├─ 파일 ID와 provider object ID
  ├─ TL/TLC
  ├─ 사용시간/정산
  └─ 추천/기여 데이터

재생:
청취자 → TimeLink 권한 확인 → 개인 클라우드 파일 Range 스트림 → 청취자
```

TimeLink가 파일을 D1/R2에 복사하지 않는 것이 핵심이다.

## 6. 주의

Google Drive와 OneDrive의 실제 저장 용량과 트래픽/쿼터는 각 사용자의 계정 정책을 따른다. TimeLink는 그 용량을 소유하거나 보장하지 않는다.

또한 사용자가 개인 클라우드에서 파일을 삭제하면 TimeLink의 메타데이터가 남아 있어도 실제 재생은 실패할 수 있으므로, 향후 무결성 검사와 재연결/복구 기능을 추가한다.

"""
OCR 인증 서비스
- 실제: Claude Vision API로 스크린샷 분석
- 개발: 시뮬레이션 모드
"""
import json
import re
from typing import Optional
from app.core.config import settings


class OCRResult:
    def __init__(self, passed: bool, checks: list[dict], note: str = ""):
        self.passed = passed
        self.checks = checks
        self.note = note

    def to_json(self) -> str:
        return json.dumps({
            "passed": self.passed,
            "checks": self.checks,
            "note": self.note,
        }, ensure_ascii=False)


def _check(label: str, passed: bool, detail: str = "") -> dict:
    return {"label": label, "passed": passed, "detail": detail}


async def verify_ai_content(
    source_url: Optional[str],
    profile_url: Optional[str],
    capture_path: Optional[str],
    payment_proof_path: Optional[str],
    plan_type: Optional[str],
    creation_month: Optional[str],
) -> OCRResult:
    """
    AI 플랫폼 콘텐츠 인증 OCR 분석

    실제 운영 시: capture_path 파일을 Claude Vision API에 전송하여
    생성 날짜, 계정명, 곡 제목을 추출하고 payment_proof와 기간 대조
    """

    checks = []

    # 1. 소스 URL 확인
    has_source = bool(source_url and len(source_url) > 10)
    known_platforms = ["suno.com", "udio.com", "soundraw.io", "mubert.com", "aiva.ai"]
    platform_match = any(p in (source_url or "") for p in known_platforms)
    checks.append(_check(
        "AI 플랫폼 URL 확인",
        has_source and platform_match,
        f"URL: {source_url[:50] if source_url else '없음'}",
    ))

    # 2. 프로필 URL
    checks.append(_check(
        "계정 프로필 URL",
        bool(profile_url),
        f"프로필: {profile_url[:50] if profile_url else '없음 (선택사항)'}",
    ))

    # 3. 생성 화면 캡처
    checks.append(_check(
        "생성 화면 캡처 업로드",
        bool(capture_path),
        "캡처 파일 첨부됨" if capture_path else "캡처 파일 없음 — 필수 항목",
    ))

    # 4. 결제 증빙
    has_payment = bool(payment_proof_path)
    checks.append(_check(
        "결제 증빙",
        has_payment,
        "영수증/이메일 첨부됨" if has_payment else "결제 증빙 없음 — 필수 항목",
    ))

    # 5. 기간 매칭 (실제로는 OCR로 날짜 추출 후 비교)
    # 현재: creation_month가 제공되고 plan_type이 있으면 통과로 시뮬레이션
    period_ok = bool(creation_month and plan_type)
    checks.append(_check(
        "구독 기간 매칭",
        period_ok,
        f"생성월: {creation_month or '미입력'} / 플랜: {plan_type or '미입력'}",
    ))

    # 전체 통과 여부: 필수 항목 (URL, 캡처, 증빙) 모두 통과해야 함
    required_passed = all(c["passed"] for c in [checks[0], checks[2], checks[3]])
    passed = required_passed

    note = "인증 조건 충족" if passed else "필수 항목 누락 — 캡처 파일과 결제 증빙을 확인하세요"
    return OCRResult(passed=passed, checks=checks, note=note)

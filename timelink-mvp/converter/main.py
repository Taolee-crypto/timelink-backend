#!/usr/bin/env python3
import argparse
import json
import hashlib
import uuid
import os
from datetime import datetime, timedelta
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description='TimeLink Converter')
    parser.add_argument('file_path', help='변환할 파일')
    parser.add_argument('--company-id', '-c', required=True, help='회사 ID')
    parser.add_argument('--minutes', '-m', type=int, default=480, help='허용 시간(분)')
    parser.add_argument('--expire-days', '-e', type=int, default=90, help='만료일(일)')
    parser.add_argument('--output', '-o', help='출력 파일명')
    
    args = parser.parse_args()
    
    try:
        # 파일 존재 확인
        if not os.path.exists(args.file_path):
            print(f"❌ 파일을 찾을 수 없습니다: {args.file_path}")
            return
        
        # 파일 읽기
        with open(args.file_path, 'rb') as f:
            data = f.read()
        
        # 파일 정보
        file_name = os.path.basename(args.file_path)
        file_size = os.path.getsize(args.file_path)
        
        # TLD 생성
        tld = {
            'header': {
                'version': '1.0',
                'tld_id': str(uuid.uuid4()),
                'created_at': datetime.now().isoformat(),
                'company_id': args.company_id
            },
            'content': {
                'original_name': file_name,
                'file_hash': hashlib.sha256(data).hexdigest(),
                'file_size': file_size,
                'file_path': args.file_path
            },
            'policy': {
                'allowed_minutes': args.minutes,
                'expire_at': (datetime.now() + timedelta(days=args.expire_days)).isoformat(),
                'max_views': 10,
                'watermark_enabled': True
            },
            'usage': {
                'used_minutes': 0.0,
                'view_count': 0,
                'last_accessed': None,
                'devices': []
            }
        }
        
        # 출력 파일명 결정
        if args.output:
            output_file = args.output
        else:
            output_file = f"{args.file_path}.tld"
        
        # 저장
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(tld, f, indent=2, ensure_ascii=False)
        
        print("\n" + "="*50)
        print("✅ TimeLink 변환 완료!")
        print("="*50)
        print(f"원본 파일: {file_name}")
        print(f"TLD 파일: {output_file}")
        print(f"허용 시간: {args.minutes}분")
        print(f"만료일: {tld['policy']['expire_at'][:10]}")
        print(f"파일 해시: {tld['content']['file_hash'][:16]}...")
        print("="*50)
        
    except Exception as e:
        print(f"❌ 오류 발생: {e}")

if __name__ == '__main__':
    main()

#!/usr/bin/env python3
import argparse
import json
import time
import os
from datetime import datetime

def cli_main():
    parser = argparse.ArgumentParser(description='TimeLink Viewer')
    parser.add_argument('tld_file', help='TLD 파일')
    parser.add_argument('--check', '-c', action='store_true', help='정보 확인만')
    parser.add_argument('--simulate', '-s', action='store_true', help='실행 시뮬레이션')
    parser.add_argument('--time', '-t', type=int, default=10, help='실행 시간(초)')
    
    args = parser.parse_args()
    
    try:
        # 파일 존재 확인
        if not os.path.exists(args.tld_file):
            print(f"❌ TLD 파일을 찾을 수 없습니다: {args.tld_file}")
            return
        
        # TLD 파일 로드
        with open(args.tld_file, 'r', encoding='utf-8') as f:
            tld = json.load(f)
        
        # 정보 표시
        print("\n" + "="*50)
        print("📄 TimeLink Viewer")
        print("="*50)
        print(f"파일명: {tld['content']['original_name']}")
        print(f"파일 크기: {tld['content']['file_size']:,} bytes")
        print(f"해시: {tld['content']['file_hash'][:16]}...")
        print(f"생성일: {tld['header']['created_at'][:10]}")
        print(f"회사: {tld['header'].get('company_id', 'N/A')}")
        print("-"*30)
        print(f"허용 시간: {tld['policy']['allowed_minutes']} 분")
        print(f"사용 시간: {tld['usage']['used_minutes']:.1f} 분")
        
        remaining = tld['policy']['allowed_minutes'] - tld['usage']['used_minutes']
        print(f"남은 시간: {remaining:.1f} 분")
        
        if 'max_views' in tld['policy']:
            print(f"조회수: {tld['usage'].get('view_count', 0)}/{tld['policy']['max_views']}")
        
        if 'expire_at' in tld['policy']:
            expire_date = tld['policy']['expire_at'][:10]
            print(f"만료일: {expire_date}")
        
        print("="*50)
        
        # 정보 확인 모드
        if args.check:
            print("✅ 정보 확인 완료")
            return
        
        # 접근 권한 확인
        if remaining <= 0:
            print("❌ 사용 가능 시간이 초과되었습니다.")
            return
        
        if 'expire_at' in tld['policy']:
            expire_date = datetime.fromisoformat(tld['policy']['expire_at'])
            if datetime.now() > expire_date:
                print("❌ 문서가 만료되었습니다.")
                return
        
        if 'max_views' in tld['policy']:
            if tld['usage'].get('view_count', 0) >= tld['policy']['max_views']:
                print("❌ 최대 조회수를 초과했습니다.")
                return
        
        # 실행 시뮬레이션
        print(f"\n▶️  문서 실행 중... (시뮬레이션: {args.time}초)")
        
        try:
            for i in range(args.time):
                time.sleep(1)
                used = tld['usage']['used_minutes'] + (i + 1) / 60
                remaining = tld['policy']['allowed_minutes'] - used
                
                if i % 5 == 0 or i == args.time - 1:
                    print(f"  {i+1}초 경과 | 사용: {used:.1f}분 | 남음: {remaining:.1f}분")
                
                if remaining <= 0:
                    print("  ⚠️  시간 초과! 강제 종료됩니다.")
                    break
            
            print("\n✅ 실행 완료")
            
            # 사용 기록 업데이트 (예시)
            tld['usage']['used_minutes'] += args.time / 60
            tld['usage']['view_count'] = tld['usage'].get('view_count', 0) + 1
            tld['usage']['last_accessed'] = datetime.now().isoformat()
            
            # TLD 파일 업데이트 (실제 구현에서는)
            print(f"\n📝 사용 기록 업데이트:")
            print(f"  총 사용 시간: {tld['usage']['used_minutes']:.2f}분")
            print(f"  조회수: {tld['usage']['view_count']}")
            print(f"  남은 시간: {remaining:.1f}분")
            
        except KeyboardInterrupt:
            print("\n\n⏹️  사용자에 의해 중단됨")
            
    except json.JSONDecodeError:
        print("❌ TLD 파일 형식이 잘못되었습니다.")
    except Exception as e:
        print(f"❌ 오류 발생: {e}")

if __name__ == '__main__':
    cli_main()

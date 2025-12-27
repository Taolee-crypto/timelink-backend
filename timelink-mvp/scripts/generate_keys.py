#!/usr/bin/env python3
import os
from pathlib import Path

def generate_test_keys():
    keys_dir = Path("keys")
    keys_dir.mkdir(exist_ok=True)
    
    # 테스트 개인키
    with open(keys_dir / "private_test.key", "w") as f:
        f.write("# 테스트 개인키\n")
    
    # 테스트 공개키
    with open(keys_dir / "public_test.pub", "w") as f:
        f.write("# 테스트 공개키\n")
    
    print("✅ 테스트 키 생성 완료")

if __name__ == "__main__":
    generate_test_keys()

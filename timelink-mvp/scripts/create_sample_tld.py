#!/usr/bin/env python3
import json
import uuid
from datetime import datetime, timedelta
from pathlib import Path

def create_sample_tld():
    sample_dir = Path("examples")
    sample_dir.mkdir(exist_ok=True)
    
    sample_tld = {
        "header": {
            "tld_id": str(uuid.uuid4()),
            "created_at": datetime.now().isoformat()
        },
        "content": {
            "original_name": "sample_document.pdf",
            "file_hash": "test_hash_123456",
            "file_size": 102400
        },
        "policy": {
            "allowed_minutes": 60
        }
    }
    
    output_path = sample_dir / "sample.tld"
    with open(output_path, 'w') as f:
        json.dump(sample_tld, f, indent=2)
    
    print(f"✅ 샘플 TLD 생성: {output_path}")

if __name__ == "__main__":
    create_sample_tld()

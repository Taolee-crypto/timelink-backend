#!/usr/bin/env python3
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from viewer.gui_viewer import gui_main
    gui_main()
except ImportError as e:
    print(f"GUI 모드를 실행할 수 없습니다: {e}")
    print("PyQt5를 설치하세요: pip install PyQt5")
    sys.exit(1)

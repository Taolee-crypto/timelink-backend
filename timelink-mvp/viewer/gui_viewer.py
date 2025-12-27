#!/usr/bin/env python3
import sys
import json
import os
from PyQt5.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout, 
                            QHBoxLayout, QLabel, QPushButton, QTextEdit, 
                            QFileDialog, QMessageBox)
from PyQt5.QtCore import Qt
from datetime import datetime

class TimeLinkViewer(QMainWindow):
    def __init__(self):
        super().__init__()
        self.current_tld = None
        self.init_ui()
    
    def init_ui(self):
        self.setWindowTitle('TimeLink Viewer')
        self.setGeometry(100, 100, 500, 400)
        
        # 중앙 위젯
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        # 레이아웃
        layout = QVBoxLayout()
        central_widget.setLayout(layout)
        
        # 제목
        title_label = QLabel('TimeLink Viewer')
        title_label.setStyleSheet("font-size: 20px; font-weight: bold; padding: 10px;")
        title_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(title_label)
        
        # 파일 선택 버튼
        file_layout = QHBoxLayout()
        self.file_label = QLabel('파일: 선택되지 않음')
        self.file_label.setStyleSheet("border: 1px solid #ccc; padding: 5px;")
        
        select_btn = QPushButton('TLD 파일 선택')
        select_btn.clicked.connect(self.select_file)
        
        file_layout.addWidget(self.file_label)
        file_layout.addWidget(select_btn)
        layout.addLayout(file_layout)
        
        # 정보 표시 영역
        self.info_text = QTextEdit()
        self.info_text.setReadOnly(True)
        self.info_text.setStyleSheet("font-family: monospace;")
        layout.addWidget(self.info_text)
        
        # 버튼 영역
        button_layout = QHBoxLayout()
        
        self.check_btn = QPushButton('정보 확인')
        self.check_btn.clicked.connect(self.check_info)
        self.check_btn.setEnabled(False)
        
        self.view_btn = QPushButton('문서 열기')
        self.view_btn.clicked.connect(self.view_document)
        self.view_btn.setEnabled(False)
        
        button_layout.addWidget(self.check_btn)
        button_layout.addWidget(self.view_btn)
        layout.addLayout(button_layout)
        
        # 상태 표시줄
        self.status_label = QLabel('준비됨')
        self.status_label.setStyleSheet("padding: 5px; background-color: #f0f0f0;")
        layout.addWidget(self.status_label)
    
    def select_file(self):
        file_path, _ = QFileDialog.getOpenFileName(
            self, 'TLD 파일 선택', '', 'TLD 파일 (*.tld);;모든 파일 (*.*)'
        )
        
        if file_path:
            self.file_label.setText(f'파일: {os.path.basename(file_path)}')
            self.load_tld(file_path)
    
    def load_tld(self, file_path):
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                self.current_tld = json.load(f)
            
            self.check_btn.setEnabled(True)
            self.view_btn.setEnabled(True)
            self.status_label.setText('TLD 파일 로드됨')
            
        except Exception as e:
            QMessageBox.critical(self, '오류', f'TLD 파일 로드 실패: {str(e)}')
            self.status_label.setText('로드 실패')
    
    def check_info(self):
        if not self.current_tld:
            return
        
        info = "📄 TLD 정보\n"
        info += "="*40 + "\n"
        
        content = self.current_tld['content']
        policy = self.current_tld['policy']
        usage = self.current_tld['usage']
        
        info += f"파일명: {content.get('original_name', 'N/A')}\n"
        info += f"크기: {content.get('file_size', 0):,} bytes\n"
        info += f"해시: {content.get('file_hash', 'N/A')[:16]}...\n\n"
        
        info += "📋 정책 정보\n"
        info += "-"*20 + "\n"
        info += f"허용 시간: {policy.get('allowed_minutes', 0)} 분\n"
        info += f"사용 시간: {usage.get('used_minutes', 0):.1f} 분\n"
        
        remaining = policy.get('allowed_minutes', 0) - usage.get('used_minutes', 0)
        info += f"남은 시간: {remaining:.1f} 분\n"
        
        if 'max_views' in policy:
            info += f"조회수: {usage.get('view_count', 0)}/{policy['max_views']}\n"
        
        if 'expire_at' in policy:
            info += f"만료일: {policy['expire_at'][:10]}\n"
        
        self.info_text.setText(info)
        self.status_label.setText('정보 확인 완료')
    
    def view_document(self):
        if not self.current_tld:
            return
        
        # 접근 권한 확인
        policy = self.current_tld['policy']
        usage = self.current_tld['usage']
        
        remaining = policy.get('allowed_minutes', 0) - usage.get('used_minutes', 0)
        
        if remaining <= 0:
            QMessageBox.warning(self, '경고', '사용 가능 시간이 초과되었습니다.')
            return
        
        QMessageBox.information(
            self, '문서 열기',
            f'문서를 엽니다.\n원본 파일: {self.current_tld["content"]["original_name"]}\n'
            f'남은 시간: {remaining:.1f}분'
        )
        
        self.status_label.setText('문서 실행 중...')

def gui_main():
    app = QApplication(sys.argv)
    viewer = TimeLinkViewer()
    viewer.show()
    sys.exit(app.exec_())

if __name__ == '__main__':
    gui_main()

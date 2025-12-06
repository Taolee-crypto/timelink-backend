// 데이터베이스 연결 테스트 스크립트
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

async function testDatabase() {
    console.log('📊 데이터베이스 연결 테스트 시작...\n');
    
    try {
        // SQLite 데이터베이스 연결 (로컬 테스트용)
        const db = await open({
            filename: './timelink-test.db',
            driver: sqlite3.Database
        });
        
        console.log('✅ 데이터베이스 연결 성공');
        
        // 스키마 적용
        const schema = await import('fs').then(fs => 
            fs.readFileSync('./schema.sql', 'utf8')
        );
        
        await db.exec(schema);
        console.log('✅ 스키마 적용 완료');
        
        // 기본 테스트
        console.log('\n🔍 테이블 확인:');
        const tables = await db.all(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        );
        
        tables.forEach(table => {
            console.log(`  - ${table.name}`);
        });
        
        // 사용자 수 확인
        const userCount = await db.get("SELECT COUNT(*) as count FROM users");
        console.log(`\n👥 초기 사용자 수: ${userCount.count}`);
        
        // 샘플 쿼리 테스트
        console.log('\n🧪 샘플 쿼리 테스트:');
        
        // 관리자 계정 확인
        const admin = await db.get(
            "SELECT username, email, role FROM users WHERE role = 'admin'"
        );
        
        if (admin) {
            console.log(`  관리자 계정: ${admin.username} (${admin.email})`);
        }
        
        // 데이터베이스 종료
        await db.close();
        console.log('\n✅ 데이터베이스 테스트 완료');
        
        // 테스트 파일 삭제
        await import('fs').then(fs => {
            fs.unlinkSync('./timelink-test.db');
            console.log('🧹 테스트 데이터베이스 파일 삭제됨');
        });
        
    } catch (error) {
        console.error('❌ 데이터베이스 테스트 실패:', error.message);
        process.exit(1);
    }
}

// 실행
if (import.meta.url === `file://${process.argv[1]}`) {
    testDatabase();
}

export { testDatabase };

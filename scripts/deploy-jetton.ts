/**
 * TLC Jetton 배포 스크립트
 * npx ts-node scripts/deploy-jetton.ts
 */

import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import * as fs from 'fs';

async function main() {
  console.log('');
  console.log('===========================================');
  console.log('  TLC Jetton 배포 스크립트');
  console.log('===========================================');
  console.log('');

  // 1. 24단어 니모닉 생성
  console.log('📝 Admin 지갑 생성 중...');
  const mnemonic = await mnemonicNew(24);
  const keyPair  = await mnemonicToPrivateKey(mnemonic);

  // 2. 지갑 주소 계산
  const wallet = WalletContractV4.create({
    publicKey: keyPair.publicKey,
    workchain: 0,
  });
  const walletAddr = wallet.address.toString({ bounceable: false, testOnly: false });

  console.log('');
  console.log('⚠️  니모닉 (안전하게 보관하세요):');
  console.log('-------------------------------------------');
  console.log(mnemonic.join(' '));
  console.log('-------------------------------------------');
  console.log('');
  console.log('💎 Admin 지갑 주소:');
  console.log('   ' + walletAddr);
  console.log('');
  console.log('📌 다음 단계:');
  console.log('');
  console.log('1) 위 주소에 0.5 TON 입금:');
  console.log('   https://tonscan.org/address/' + walletAddr);
  console.log('');
  console.log('2) wrangler secret 등록:');
  console.log('');
  console.log('   npx wrangler secret put TON_ADMIN_MNEMONIC');
  console.log('   >> ' + mnemonic.join(' '));
  console.log('');
  console.log('   npx wrangler secret put TON_ADMIN_WALLET');
  console.log('   >> ' + walletAddr);
  console.log('');

  // 백업 파일 저장
  fs.writeFileSync('TON_ADMIN_BACKUP.json', JSON.stringify({
    mnemonic: mnemonic.join(' '),
    wallet_address: walletAddr,
    created_at: new Date().toISOString(),
    note: '이 파일을 git에 커밋하지 마세요!'
  }, null, 2));

  // .gitignore 업데이트
  const gi = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore','utf-8') : '';
  if (!gi.includes('TON_ADMIN_BACKUP.json')) {
    fs.appendFileSync('.gitignore', '\nTON_ADMIN_BACKUP.json\n');
  }

  console.log('✅ TON_ADMIN_BACKUP.json 저장 완료 (절대 공유/커밋 금지!)');
  console.log('');
}

main().catch(e => {
  console.error('오류:', e.message);
  process.exit(1);
});

// TLC Jetton Admin 지갑 생성 (테스트넷)
// node scripts/deploy-jetton-testnet.js

const { mnemonicNew, mnemonicToPrivateKey } = require('@ton/crypto');
const { WalletContractV4 } = require('@ton/ton');
const fs = require('fs');

async function main() {
  console.log('\n=== TLC Jetton Admin 지갑 생성 (TESTNET) ===\n');

  const mnemonic = await mnemonicNew(24);
  const keyPair  = await mnemonicToPrivateKey(mnemonic);

  const wallet = WalletContractV4.create({
    publicKey: keyPair.publicKey,
    workchain: 0,
  });

  // testOnly: true → 테스트넷 주소 형식
  const addr = wallet.address.toString({ bounceable: false, testOnly: true });

  console.log('니모닉 (안전하게 보관 - 화면에서만 확인):');
  console.log(mnemonic.join(' '));
  console.log('');
  console.log('테스트넷 Admin 지갑 주소:');
  console.log(addr);
  console.log('');
  console.log('>>> 다음 단계:');
  console.log('1. 테스트넷 TON 무료 받기 (Faucet):');
  console.log('   https://t.me/testgiver_ton_bot');
  console.log('   위 주소를 봇에 붙여넣으면 5 TON 무료 지급');
  console.log('');
  console.log('2. 잔액 확인:');
  console.log('   https://testnet.tonscan.org/address/' + addr);
  console.log('');
  console.log('3. 받은 후 알려주세요 → Jetton 컨트랙트 배포 진행');

  fs.writeFileSync('TON_TESTNET_BACKUP.json', JSON.stringify({
    mnemonic: mnemonic.join(' '),
    wallet_address: addr,
    network: 'testnet',
    created_at: new Date().toISOString(),
    note: '테스트넷용 — 커밋 금지!'
  }, null, 2));

  const gi = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore','utf-8') : '';
  if (!gi.includes('TON_TESTNET_BACKUP')) fs.appendFileSync('.gitignore', '\nTON_TESTNET_BACKUP.json\n');

  console.log('\nTON_TESTNET_BACKUP.json 저장 완료');
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });

// TLC Admin 지갑 생성 스크립트 (CommonJS)
// node scripts/deploy-jetton.js

const { mnemonicNew, mnemonicToPrivateKey } = require('@ton/crypto');
const { WalletContractV4 } = require('@ton/ton');
const fs = require('fs');

async function main() {
  console.log('\n=== TLC Jetton Admin 지갑 생성 ===\n');

  const mnemonic = await mnemonicNew(24);
  const keyPair  = await mnemonicToPrivateKey(mnemonic);

  const wallet = WalletContractV4.create({
    publicKey: keyPair.publicKey,
    workchain: 0,
  });
  const addr = wallet.address.toString({ bounceable: false, testOnly: false });

  console.log('니모닉 (안전하게 보관!):');
  console.log(mnemonic.join(' '));
  console.log('');
  console.log('Admin 지갑 주소:');
  console.log(addr);
  console.log('');
  console.log('>>> 다음 단계:');
  console.log('1. 위 주소에 0.5 TON 입금: https://tonscan.org/address/' + addr);
  console.log('2. npx wrangler secret put TON_ADMIN_MNEMONIC  (값: 위 니모닉)');
  console.log('3. npx wrangler secret put TON_ADMIN_WALLET    (값: 위 주소)');

  fs.writeFileSync('TON_ADMIN_BACKUP.json', JSON.stringify({
    mnemonic: mnemonic.join(' '),
    wallet_address: addr,
    created_at: new Date().toISOString()
  }, null, 2));

  const gi = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore','utf-8') : '';
  if (!gi.includes('TON_ADMIN_BACKUP')) fs.appendFileSync('.gitignore', '\nTON_ADMIN_BACKUP.json\n');

  console.log('\nTON_ADMIN_BACKUP.json 저장 완료 (커밋 금지!)');
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });

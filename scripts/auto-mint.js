// TLC 자동 민팅 스크립트 (5:5 분배)
// node scripts/auto-mint.js

const { mnemonicToPrivateKey } = require('@ton/crypto');
const { WalletContractV4, TonClient, toNano, internal, beginCell, Address } = require('@ton/ton');

const CONFIG = {
  mnemonic: 'frozen rocket harsh cause cherry muffin village enlist juice ginger ridge load crucial walk scout luggage more foster taste victory tool detail thing deer',
  minterAddr: 'EQA2RN8fRocgG8KcRYCHnZrQiIfOXpzoTgOB_MkiF2TqauJP',
  platformAddr: 'UQDazCwQSrWNjIz0OE7cttiVuLEcmGNLEQiw82nXuc5ZYsmh',
  apiEndpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
  apiKey: 'cc70e713dd99c56ad4ba23ee1eae2f8545f2e71d774c35f7e2ece915e6ed9c55',
  timelinkApi: 'https://api.timelink.digital',
};

async function getPendingWithdrawals() {
  const res = await fetch(CONFIG.timelinkApi + '/api/admin/sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: "SELECT * FROM tlc_withdrawals WHERE status='pending' ORDER BY created_at ASC LIMIT 10" })
  });
  const d = await res.json();
  return d.results || [];
}

async function updateWithdrawalStatus(id, status, txHash) {
  await fetch(CONFIG.timelinkApi + '/api/admin/sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: `UPDATE tlc_withdrawals SET status='${status}', tx_hash='${txHash}', processed_at=datetime('now') WHERE id=${id}` })
  });
}

async function mintTo(ct, keyPair, adminAddr, toAddress, amount) {
  const minterAddr = Address.parse(CONFIG.minterAddr);
  const toAddr = Address.parse(toAddress);
  const jettonAmount = toNano(String(amount));
  const seqno = await ct.getSeqno();

  const forwardPayload = beginCell()
    .storeUint(0x178d4519, 32)
    .storeUint(Date.now(), 64)
    .storeCoins(jettonAmount)
    .storeAddress(adminAddr)
    .storeAddress(adminAddr)
    .storeCoins(1n)
    .storeUint(0, 1)
  .endCell();

  const mintBody = beginCell()
    .storeUint(21, 32)
    .storeUint(Date.now(), 64)
    .storeAddress(toAddr)
    .storeCoins(toNano('0.2'))
    .storeRef(forwardPayload)
  .endCell();

  await ct.sendTransfer({
    secretKey: keyPair.secretKey,
    seqno,
    messages: [internal({ to: minterAddr, value: toNano('0.3'), body: mintBody, bounce: true })]
  });

  await new Promise(r => setTimeout(r, 15000));
}

async function main() {
  console.log('\n=== TLC 자동 민팅 (5:5 분배) ===\n');

  const keyPair = await mnemonicToPrivateKey(CONFIG.mnemonic.split(' '));
  const wallet  = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
  const client  = new TonClient({ endpoint: CONFIG.apiEndpoint, apiKey: CONFIG.apiKey });
  const ct      = client.open(wallet);

  const balance = await ct.getBalance();
  console.log('Admin 잔액:', (Number(balance) / 1e9).toFixed(4), 'TON');

  if (balance < toNano('0.7')) {
    console.error('잔액 부족! 최소 0.7 TON 필요');
    return;
  }

  const withdrawals = await getPendingWithdrawals();
  console.log('대기 중인 출금:', withdrawals.length, '건\n');

  for (const wd of withdrawals) {
    const userAmount     = Math.floor(wd.tlc_amount * 0.5 * 1000) / 1000;
    const platformAmount = Math.floor(wd.tlc_amount * 0.5 * 1000) / 1000;

    console.log(`처리 중: #${wd.id}`);
    console.log(`  총액: ${wd.tlc_amount} TLC`);
    console.log(`  유저(50%): ${userAmount} TLC → ${wd.ton_address}`);
    console.log(`  플랫폼(50%): ${platformAmount} TLC → ${CONFIG.platformAddr}`);

    try {
      await updateWithdrawalStatus(wd.id, 'processing', '');

      // 유저 민팅 (50%)
      console.log('  유저 민팅 중...');
      await mintTo(ct, keyPair, wallet.address, wd.ton_address, userAmount);
      console.log('  유저 민팅 완료!');

      // 플랫폼 민팅 (50%)
      console.log('  플랫폼 민팅 중...');
      await mintTo(ct, keyPair, wallet.address, CONFIG.platformAddr, platformAmount);
      console.log('  플랫폼 민팅 완료!');

      await updateWithdrawalStatus(wd.id, 'done', 'minted_' + Date.now());
      console.log(`✅ #${wd.id} 완료!\n`);

    } catch(e) {
      console.error(`❌ #${wd.id} 실패:`, e.message);
      await updateWithdrawalStatus(wd.id, 'pending', '');
    }
  }

  console.log('=== 완료 ===');
}

main().catch(console.error);

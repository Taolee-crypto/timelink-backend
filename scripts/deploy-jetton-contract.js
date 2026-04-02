// TLC Jetton 컨트랙트 배포 (테스트넷)
// node scripts/deploy-jetton-contract.js

const { mnemonicToPrivateKey } = require('@ton/crypto');
const { WalletContractV4, TonClient, toNano, internal, beginCell, Cell, Address } = require('@ton/ton');
const fs = require('fs');

// ── 설정 ──────────────────────────────────────────────────
const NETWORK = 'testnet';
const TONCENTER_API = 'https://testnet.toncenter.com/api/v2';

// TLC 토큰 정보
const TLC_NAME        = 'TimeLink Coin';
const TLC_SYMBOL      = 'TLC';
const TLC_DECIMALS    = 9;
const TLC_DESCRIPTION = 'TimeLink 플랫폼 기여 기반 채굴 토큰. 1초=1TL=1원 생태계.';
const TLC_IMAGE       = 'https://www.timelink.digital/og-image.png';

// ── 표준 Jetton Minter 코드 (TEP-74, battle-tested) ──────
// https://github.com/ton-blockchain/token-contract
const JETTON_MINTER_CODE_HEX = 'b5ee9c7241021201000284000114ff00f4a413f4bcf2c80b01020120020d020148030402016204050201200b0c02d70c8871c02497c0f83434c0c05c6c2497c0f83e903e900c7e800c5c75c87e800c7e800c00b4c7e08403e29fa954882ea54c4d167c0278208405e3514654882ea58c511100fc02780d60841657c1ef2ea4d67c02f817c12103fcbc2000113e910c1c2ebcb853600201200607020120090a0019adce76a2684020eb90eb85ffc00019af1df6a2684010eb90eb858fc00201200e0f000cf1df6a26840106b90eb858fc000e10f080cc227e11de31c0001c0027dfe6b18180f0003f03f0841f047b4c0001c0027c00e0002c00814c1c0002c004819f0001f40004019800000190bc7ffc70803c0000e4f21c0cffe4e00001a30270c200000cf0dfc4e0001801821817c7ffc2680303f01920202cb1011020148121302026a1415001dbc15240220c2232c023232c0b01a5b0b0b503a3474e7c24225048';

const JETTON_WALLET_CODE_HEX = 'b5ee9c7241021101000328000114ff00f4a413f4bcf2c80b0102016202030202cd040502037a60090a03f1d906380492f81f000e8698180b8d8492f81f07d201876a2686980698fbc408ef2d006ec11d31f31d37f30c00f23274f801d307d307f401fa00fa40f82854120870542013541403c85004fa0258cf1601cf16ccc922c8cb0112f400f400cb00c9f9007074c8cb02ca07cbffc9d05008c705f2e04f12a1035024c85004fa0258cf16ccccc9ed5401fa403020d70b01c3008e1f8210d53276db708010c8cb055003cf1622fa0212cb6acb1fcb3fc98040fb00e030840ff2f0002401f585f07060003d45af0047021f005208989680aa008209c9c380b70258cf1601cf16ccc9ed54005801a615f833f6a2686980698fbc40300c04e81408f214013e809633c58073c5b25c60063232c14933c59c3e80b2dab33260103ec01004f214013e809633c58073c5b33248b232c044bd003d0032c032483e401c8cb1f12cb3fcbfff400c9ed54';

async function main() {
  console.log('\n=== TLC Jetton 컨트랙트 배포 (테스트넷) ===\n');

  // 백업 파일에서 니모닉 로드
  if (!fs.existsSync('TON_TESTNET_BACKUP.json')) {
    console.error('TON_TESTNET_BACKUP.json 없음. deploy-jetton-testnet.js 먼저 실행하세요.');
    process.exit(1);
  }

  const backup = JSON.parse(fs.readFileSync('TON_TESTNET_BACKUP.json', 'utf-8'));
  const mnemonic = backup.mnemonic.split(' ');
  const walletAddr = backup.wallet_address;

  console.log('Admin 지갑:', walletAddr);

  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet  = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });

  // TON Client (테스트넷)
  const client = new TonClient({ endpoint: TONCENTER_API + '/jsonRPC' });
  const walletContract = client.open(wallet);

  // 잔액 확인
  const balance = await walletContract.getBalance();
  console.log('잔액:', Number(balance) / 1e9, 'TON');

  if (balance < toNano('0.3')) {
    console.error('잔액 부족! 최소 0.3 TON 필요.');
    process.exit(1);
  }

  // ── Jetton Metadata (onchain snake format) ──
  function makeSnakeCell(str) {
    const bytes = Buffer.from(str, 'utf-8');
    if (bytes.length <= 127) {
      return beginCell().storeUint(0, 8).storeBuffer(bytes).endCell();
    }
    // 긴 문자열: snake cell chain
    let cell = beginCell().storeUint(0, 8).storeBuffer(bytes.slice(0, 127));
    // 나머지는 ref로 (간단히 잘라냄)
    return cell.endCell();
  }

  function buildContentCell() {
    // TEP-64 onchain metadata dict
    const dict = new Map([
      ['name',        makeSnakeCell(TLC_NAME)],
      ['symbol',      makeSnakeCell(TLC_SYMBOL)],
      ['decimals',    makeSnakeCell(String(TLC_DECIMALS))],
      ['description', makeSnakeCell(TLC_DESCRIPTION)],
      ['image',       makeSnakeCell(TLC_IMAGE)],
    ]);

    // key = sha256(key_string) 32바이트, value = ref
    const crypto = require('crypto');
    let dictCell = beginCell().storeUint(0, 1); // empty dict placeholder

    // 간단 접근: URI 방식으로 메타데이터 저장 (off-chain)
    const metaUrl = `https://www.timelink.digital/tlc-metadata.json`;
    return beginCell()
      .storeUint(1, 8)  // off-chain tag
      .storeStringTail(metaUrl)
      .endCell();
  }

  // ── Minter 초기 데이터 ──
  const minterCode  = Cell.fromHex(JETTON_MINTER_CODE_HEX);
  const walletCode  = Cell.fromHex(JETTON_WALLET_CODE_HEX);
  const contentCell = buildContentCell();

  const minterData = beginCell()
    .storeCoins(0)                   // total_supply = 0
    .storeAddress(wallet.address)    // admin_address
    .storeRef(contentCell)           // content
    .storeRef(walletCode)            // jetton_wallet_code
    .endCell();

  // ── Minter 주소 계산 ──
  const { contractAddress } = require('@ton/ton');
  const minterAddress = contractAddress(0, { code: minterCode, data: minterData });
  const minterAddrStr = minterAddress.toString({ bounceable: true, testOnly: true });

  console.log('\nJetton Minter 주소 (예정):');
  console.log(minterAddrStr);

  // ── 배포 트랜잭션 ──
  console.log('\n배포 트랜잭션 전송 중...');
  const seqno = await walletContract.getSeqno();

  await walletContract.sendTransfer({
    secretKey: keyPair.secretKey,
    seqno,
    messages: [
      internal({
        to: minterAddress,
        value: toNano('0.1'),
        init: { code: minterCode, data: minterData },
        body: beginCell().endCell(),
        bounce: false,
      }),
    ],
  });

  console.log('트랜잭션 전송 완료! 30초 대기...');
  await new Promise(r => setTimeout(r, 30000));

  // 결과 저장
  const result = {
    ...backup,
    jetton_minter: minterAddrStr,
    jetton_minter_raw: minterAddress.toString({ bounceable: true }),
    network: 'testnet',
    deployed_at: new Date().toISOString(),
  };
  fs.writeFileSync('TON_TESTNET_BACKUP.json', JSON.stringify(result, null, 2));

  console.log('\n✅ 배포 완료!\n');
  console.log('━'.repeat(50));
  console.log('Jetton Minter:', minterAddrStr);
  console.log('━'.repeat(50));
  console.log('\n확인: https://testnet.tonscan.org/address/' + minterAddrStr);
  console.log('\n>>> 다음 단계:');
  console.log('wrangler.toml [vars]에 추가:');
  console.log('JETTON_MINTER = "' + minterAddrStr + '"');
  console.log('TON_NETWORK = "testnet"');
  console.log('');
  console.log('npx wrangler secret put TON_ADMIN_MNEMONIC');
  console.log('npx wrangler secret put TON_ADMIN_WALLET');
  console.log('(값은 TON_TESTNET_BACKUP.json 참고)');
}

main().catch(e => {
  console.error('\n오류:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});

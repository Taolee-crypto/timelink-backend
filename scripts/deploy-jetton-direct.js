const { mnemonicToPrivateKey } = require("@ton/crypto");
const { WalletContractV4, TonClient, toNano, internal, beginCell, contractAddress } = require("@ton/ton");
const { Cell } = require("ton-core");
const fs = require("fs");
const https = require("https");

const ENDPOINT = "https://testnet.toncenter.com/api/v2/jsonRPC";

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "node" } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) return fetchBinary(res.headers.location).then(resolve).catch(reject);
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {
  console.log("\n=== TLC Jetton 배포 (테스트넷) ===\n");
  const backup = JSON.parse(fs.readFileSync("TON_TESTNET_BACKUP.json", "utf-8"));
  const mnemonic = backup.mnemonic.split(" ");
  console.log("Admin 지갑:", backup.wallet_address);
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
  const client = new TonClient({ endpoint: ENDPOINT });
  const contract = client.open(wallet);
  const balance = await contract.getBalance();
  console.log("잔액:", (Number(balance) / 1e9).toFixed(4), "TON");
  if (balance < toNano("0.1")) { console.error("잔액 부족!"); process.exit(1); }

  console.log("컨트랙트 다운로드 중...");
  const minterBuf = await fetchBinary("https://raw.githubusercontent.com/ton-blockchain/token-contract/21c260f7bbc37de3d6fa28b0aa7e2e00cb9a5474/ft/jetton-minter.cell");
  const walletBuf = await fetchBinary("https://raw.githubusercontent.com/ton-blockchain/token-contract/21c260f7bbc37de3d6fa28b0aa7e2e00cb9a5474/ft/jetton-wallet.cell");
  console.log("minter:", minterBuf.length, "bytes / wallet:", walletBuf.length, "bytes");

  const MINTER_CODE = Cell.fromBoc(minterBuf)[0];
  const WALLET_CODE = Cell.fromBoc(walletBuf)[0];

  const contentCell = beginCell().storeUint(0x01, 8).storeStringTail("https://www.timelink.digital/tlc-metadata.json").endCell();
  const minterData = beginCell().storeCoins(0).storeAddress(wallet.address).storeRef(contentCell).storeRef(WALLET_CODE).endCell();
  const minterAddr = contractAddress(0, { code: MINTER_CODE, data: minterData });
  const minterStr = minterAddr.toString({ bounceable: true, testOnly: true });
  console.log("\nMinter 주소:", minterStr);

  const seqno = await contract.getSeqno();
  await contract.sendTransfer({ secretKey: keyPair.secretKey, seqno, messages: [internal({ to: minterAddr, value: toNano("0.05"), init: { code: MINTER_CODE, data: minterData }, body: beginCell().endCell(), bounce: false })] });
  console.log("전송 완료! 20초 대기...");
  await new Promise(r => setTimeout(r, 20000));

  backup.jetton_minter = minterStr;
  backup.deployed_at = new Date().toISOString();
  fs.writeFileSync("TON_TESTNET_BACKUP.json", JSON.stringify(backup, null, 2));
  console.log("\n✅ 배포 완료!");
  console.log("Minter:", minterStr);
  console.log("확인: https://testnet.tonscan.org/address/" + minterStr);
  console.log('\nwrangler.toml 추가:\nJETTON_MINTER = "' + minterStr + '"\nTON_NETWORK = "testnet"');
}

main().catch(e => { console.error("\n오류:", e.message); process.exit(1); });

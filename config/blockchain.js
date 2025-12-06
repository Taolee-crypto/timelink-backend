const { ethers } = require('ethers');
const constants = require('./constants');

class BlockchainConfig {
  constructor() {
    this.network = constants.BLOCKCHAIN.NETWORK;
    this.chainId = constants.BLOCKCHAIN.CHAIN_ID;
    this.provider = this._createProvider();
    this.wallet = this._createWallet();
    this.contracts = this._initializeContracts();
  }

  _createProvider() {
    const rpcUrl = constants.BLOCKCHAIN.RPC_URLS[this.network] || 
                   process.env.BLOCKCHAIN_RPC_URL;
    
    if (!rpcUrl) {
      throw new Error('Blockchain RPC URL not configured');
    }

    return new ethers.JsonRpcProvider(rpcUrl, {
      chainId: this.chainId,
      name: this.network
    });
  }

  _createWallet() {
    const privateKey = process.env.BLOCKCHAIN_WALLET_PRIVATE_KEY;
    
    if (!privateKey) {
      console.warn('Blockchain wallet private key not configured. Using read-only mode.');
      return null;
    }

    return new ethers.Wallet(privateKey, this.provider);
  }

  _initializeContracts() {
    const contracts = {};
    const contractAddresses = constants.BLOCKCHAIN.CONTRACT_ADDRESSES;

    // TLT Token Contract (ERC-20)
    if (contractAddresses.TLT_TOKEN) {
      const tltABI = [
        'function balanceOf(address) view returns (uint256)',
        'function transfer(address, uint256) returns (bool)',
        'function approve(address, uint256) returns (bool)',
        'function transferFrom(address, address, uint256) returns (bool)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
        'function name() view returns (string)',
        'function totalSupply() view returns (uint256)'
      ];
      
      contracts.TLT = new ethers.Contract(
        contractAddresses.TLT_TOKEN,
        tltABI,
        this.wallet || this.provider
      );
    }

    // TimeLink Core Contract
    if (contractAddresses.TIMELINK_CORE) {
      const coreABI = [
        // TLF 관련 함수
        'function registerTLF(string memory tlfId, bytes32 fileHash, address creator) external',
        'function verifyTLF(string memory tlfId) view returns (bool)',
        'function getTLFInfo(string memory tlfId) view returns (bytes32, address, uint256)',
        
        // 재생 및 결제 관련
        'function startPlayback(string memory tlfId, address viewer) external payable',
        'function endPlayback(string memory tlfId, address viewer, uint256 duration) external',
        'function distributePayment(string memory tlfId, uint256 amount) external',
        
        // 소유권 및 권한
        'function transferTLFOwnership(string memory tlfId, address newOwner) external',
        'function setTLFPrice(string memory tlfId, uint256 pricePerMinute) external',
        'function setTLFAccess(string memory tlfId, bool isPublic) external',
        
        // 이벤트
        'event TLFRegistered(string indexed tlfId, address indexed creator, bytes32 fileHash)',
        'event PlaybackStarted(string indexed tlfId, address indexed viewer, uint256 timestamp)',
        'event PaymentDistributed(string indexed tlfId, address indexed creator, uint256 amount, uint256 fee)'
      ];
      
      contracts.Core = new ethers.Contract(
        contractAddresses.TIMELINK_CORE,
        coreABI,
        this.wallet || this.provider
      );
    }

    // TimeLink Market Contract (TL3)
    if (contractAddresses.TIMELINK_MARKET) {
      const marketABI = [
        // 마켓플레이스 함수
        'function listTLF(string memory tlfId, uint256 price) external',
        'function buyTLF(string memory tlfId) external payable',
        'function cancelListing(string memory tlfId) external',
        'function updatePrice(string memory tlfId, uint256 newPrice) external',
        
        // 오퍼 관련
        'function makeOffer(string memory tlfId, uint256 price) external payable',
        'function acceptOffer(string memory tlfId, address offerer) external',
        'function cancelOffer(string memory tlfId) external',
        
        // 로열티 설정
        'function setRoyalty(string memory tlfId, uint256 royaltyPercentage) external',
        
        // 조회 함수
        'function getListing(string memory tlfId) view returns (address, uint256, bool)',
        'function getOffers(string memory tlfId) view returns (address[], uint256[])',
        'function getMarketStats() view returns (uint256, uint256, uint256)',
        
        // 이벤트
        'event TLFListed(string indexed tlfId, address indexed seller, uint256 price)',
        'event TLFSold(string indexed tlfId, address indexed seller, address indexed buyer, uint256 price)',
        'event OfferMade(string indexed tlfId, address indexed offerer, uint256 price)'
      ];
      
      contracts.Market = new ethers.Contract(
        contractAddresses.TIMELINK_MARKET,
        marketABI,
        this.wallet || this.provider
      );
    }

    return contracts;
  }

  async getNetworkInfo() {
    try {
      const [network, blockNumber, gasPrice] = await Promise.all([
        this.provider.getNetwork(),
        this.provider.getBlockNumber(),
        this.provider.getFeeData()
      ]);

      return {
        name: network.name,
        chainId: Number(network.chainId),
        blockNumber,
        gasPrice: ethers.formatUnits(gasPrice.gasPrice || 0, 'gwei'),
        isConnected: true,
        timestamp: new Date()
      };
    } catch (error) {
      return {
        isConnected: false,
        error: error.message
      };
    }
  }

  async getWalletInfo() {
    if (!this.wallet) {
      return { hasWallet: false };
    }

    try {
      const [balance, address, nonce] = await Promise.all([
        this.provider.getBalance(this.wallet.address),
        this.wallet.address,
        this.wallet.getNonce()
      ]);

      return {
        hasWallet: true,
        address,
        balance: ethers.formatEther(balance),
        nonce,
        chainId: this.chainId
      };
    } catch (error) {
      return {
        hasWallet: true,
        error: error.message
      };
    }
  }

  async getTokenBalance(address, tokenAddress = constants.BLOCKCHAIN.TLT_TOKEN_ADDRESS) {
    try {
      if (!tokenAddress) {
        throw new Error('Token address not configured');
      }

      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function balanceOf(address) view returns (uint256)'],
        this.provider
      );

      const balance = await tokenContract.balanceOf(address);
      const decimals = await tokenContract.decimals?.() || constants.BLOCKCHAIN.TLT_DECIMALS;
      
      return ethers.formatUnits(balance, decimals);
    } catch (error) {
      console.error(`Failed to get token balance for ${address}:`, error);
      return '0';
    }
  }

  async verifyMessage(message, signature) {
    try {
      const recoveredAddress = ethers.verifyMessage(message, signature);
      return { 
        valid: true, 
        address: recoveredAddress,
        message 
      };
    } catch (error) {
      return { 
        valid: false, 
        error: error.message 
      };
    }
  }

  async sendTransaction(to, value, data = '0x') {
    if (!this.wallet) {
      throw new Error('Wallet not configured for sending transactions');
    }

    try {
      const tx = await this.wallet.sendTransaction({
        to,
        value: ethers.parseEther(value.toString()),
        data
      });

      const receipt = await tx.wait();

      return {
        success: true,
        transactionHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        status: receipt.status === 1 ? 'success' : 'failed'
      };
    } catch (error) {
      throw new Error(`Transaction failed: ${error.message}`);
    }
  }

  async estimateGas(to, value, data = '0x') {
    try {
      const gasEstimate = await this.provider.estimateGas({
        to,
        value: ethers.parseEther(value.toString()),
        data
      });

      const feeData = await this.provider.getFeeData();

      return {
        gasEstimate: gasEstimate.toString(),
        gasPrice: ethers.formatUnits(feeData.gasPrice || 0, 'gwei'),
        maxFeePerGas: ethers.formatUnits(feeData.maxFeePerGas || 0, 'gwei'),
        maxPriorityFeePerGas: ethers.formatUnits(feeData.maxPriorityFeePerGas || 0, 'gwei')
      };
    } catch (error) {
      throw new Error(`Gas estimation failed: ${error.message}`);
    }
  }

  getContract(contractName) {
    const contract = this.contracts[contractName];
    
    if (!contract) {
      throw new Error(`Contract ${contractName} not configured`);
    }
    
    return contract;
  }

  async getBlockTimestamp(blockNumber = 'latest') {
    try {
      const block = await this.provider.getBlock(blockNumber);
      return block ? block.timestamp : null;
    } catch (error) {
      console.error('Failed to get block timestamp:', error);
      return null;
    }
  }

  // 멀티체인 지원 (선택적)
  async switchNetwork(chainId) {
    const supportedChains = {
      1: { name: 'mainnet', rpc: constants.BLOCKCHAIN.RPC_URLS.mainnet },
      11155111: { name: 'sepolia', rpc: constants.BLOCKCHAIN.RPC_URLS.sepolia },
      137: { name: 'polygon', rpc: constants.BLOCKCHAIN.RPC_URLS.polygon },
      80001: { name: 'mumbai', rpc: process.env.MUMBAI_RPC_URL }
    };

    const chain = supportedChains[chainId];
    
    if (!chain) {
      throw new Error(`Chain ID ${chainId} not supported`);
    }

    this.chainId = chainId;
    this.network = chain.name;
    this.provider = new ethers.JsonRpcProvider(chain.rpc, chainId);
    
    if (this.wallet) {
      this.wallet = this.wallet.connect(this.provider);
    }

    // 컨트랙트 재초기화
    this.contracts = this._initializeContracts();

    return {
      success: true,
      chainId,
      network: chain.name
    };
  }
}

// 싱글톤 인스턴스
const blockchainConfig = new BlockchainConfig();

module.exports = blockchainConfig;

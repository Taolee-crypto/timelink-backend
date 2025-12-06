const { ethers } = require('ethers');
const blockchainConfig = require('../config/blockchain');
const constants = require('../config/constants');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

class BlockchainService {
  constructor() {
    this.provider = blockchainConfig.provider;
    this.wallet = blockchainConfig.wallet;
    this.contracts = blockchainConfig.contracts;
    this.network = blockchainConfig.network;
    this.chainId = blockchainConfig.chainId;
    
    this.initialize();
  }

  async initialize() {
    try {
      const networkInfo = await this.getNetworkInfo();
      logger.business('blockchain', 'initialized', {
        network: networkInfo.name,
        chainId: networkInfo.chainId,
        blockNumber: networkInfo.blockNumber,
        hasWallet: !!this.wallet
      });
    } catch (error) {
      logger.error(error, { context: 'BlockchainService.initialize' });
    }
  }

  // 네트워크 정보 조회
  async getNetworkInfo() {
    return await blockchainConfig.getNetworkInfo();
  }

  // 지갑 정보 조회
  async getWalletInfo() {
    return await blockchainConfig.getWalletInfo();
  }

  // 토큰 잔액 조회
  async getTokenBalance(address, tokenAddress = null) {
    try {
      const balance = await blockchainConfig.getTokenBalance(address, tokenAddress);
      return {
        success: true,
        address,
        balance,
        currency: constants.BLOCKCHAIN.TLT_SYMBOL,
        timestamp: new Date()
      };
    } catch (error) {
      logger.error(error, { 
        context: 'getTokenBalance',
        address,
        tokenAddress 
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 메시지 서명 검증
  async verifyMessage(message, signature) {
    return await blockchainConfig.verifyMessage(message, signature);
  }

  // TLF 등록
  async registerTLF(tlfId, fileHash, creatorAddress) {
    try {
      if (!this.contracts.Core) {
        throw new Error('Core contract not configured');
      }

      const tx = await this.contracts.Core.registerTLF(
        tlfId,
        ethers.keccak256(ethers.toUtf8Bytes(fileHash)),
        creatorAddress
      );

      const receipt = await tx.wait();

      // 트랜잭션 기록 저장
      const transaction = new Transaction({
        transactionId: `tlf_reg_${Date.now()}`,
        blockchain: {
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          from: tx.from,
          to: tx.to,
          chainId: this.chainId,
          network: this.network,
          gasUsed: receipt.gasUsed.toString(),
          gasPrice: tx.gasPrice?.toString(),
          timestamp: new Date()
        },
        type: 'CONTRACT_CALL',
        amount: {
          value: '0',
          currency: 'ETH',
          formatted: '0 ETH'
        },
        relatedEntities: {
          tlfId
        },
        metadata: {
          description: `Register TLF: ${tlfId}`,
          function: 'registerTLF',
          parameters: { tlfId, fileHash, creatorAddress }
        },
        status: 'confirmed',
        confirmations: 1
      });

      await transaction.save();

      return {
        success: true,
        tlfId,
        transactionHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        events: this.parseEvents(receipt, this.contracts.Core.interface)
      };

    } catch (error) {
      logger.error(error, {
        context: 'registerTLF',
        tlfId,
        creatorAddress
      });

      // 실패한 트랜잭션 기록
      await this.recordFailedTransaction({
        type: 'CONTRACT_CALL',
        function: 'registerTLF',
        params: { tlfId, fileHash, creatorAddress },
        error
      });

      return {
        success: false,
        error: error.message,
        tlfId
      };
    }
  }

  // TLF 검증
  async verifyTLF(tlfId) {
    try {
      if (!this.contracts.Core) {
        throw new Error('Core contract not configured');
      }

      const isVerified = await this.contracts.Core.verifyTLF(tlfId);
      const tlfInfo = await this.contracts.Core.getTLFInfo(tlfId);

      return {
        success: true,
        tlfId,
        verified: isVerified,
        fileHash: tlfInfo[0],
        creator: tlfInfo[1],
        registeredAt: new Date(Number(tlfInfo[2]) * 1000)
      };

    } catch (error) {
      logger.error(error, { context: 'verifyTLF', tlfId });
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 재생 시작 (블록체인)
  async startPlayback(tlfId, viewerAddress, amount = '0') {
    try {
      if (!this.contracts.Core) {
        throw new Error('Core contract not configured');
      }

      const tx = await this.contracts.Core.startPlayback(
        tlfId,
        viewerAddress,
        { value: ethers.parseEther(amount.toString()) }
      );

      const receipt = await tx.wait();

      // 트랜잭션 기록
      const transaction = new Transaction({
        transactionId: `play_start_${Date.now()}`,
        blockchain: {
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          from: viewerAddress,
          to: tx.to,
          chainId: this.chainId,
          network: this.network,
          gasUsed: receipt.gasUsed.toString(),
          timestamp: new Date()
        },
        type: 'TLF_PURCHASE',
        amount: {
          value: ethers.parseEther(amount.toString()).toString(),
          currency: 'TLT',
          formatted: `${amount} TLT`
        },
        relatedEntities: {
          tlfId
        },
        metadata: {
          description: `Start playback: ${tlfId}`,
          function: 'startPlayback'
        },
        status: 'confirmed'
      });

      await transaction.save();

      return {
        success: true,
        tlfId,
        viewerAddress,
        amount,
        transactionHash: tx.hash,
        events: this.parseEvents(receipt, this.contracts.Core.interface)
      };

    } catch (error) {
      logger.error(error, {
        context: 'startPlayback',
        tlfId,
        viewerAddress
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  // 결제 분배
  async distributePayment(tlfId, amount, viewerAddress) {
    try {
      if (!this.contracts.Core) {
        throw new Error('Core contract not configured');
      }

      const tx = await this.contracts.Core.distributePayment(
        tlfId,
        ethers.parseEther(amount.toString())
      );

      const receipt = await tx.wait();

      const events = this.parseEvents(receipt, this.contracts.Core.interface);
      const paymentEvent = events.find(e => e.name === 'PaymentDistributed');

      // 트랜잭션 기록
      const transaction = new Transaction({
        transactionId: `payment_dist_${Date.now()}`,
        blockchain: {
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          from: viewerAddress,
          to: tx.to,
          chainId: this.chainId,
          network: this.network,
          gasUsed: receipt.gasUsed.toString(),
          timestamp: new Date()
        },
        type: 'ROYALTY_PAYMENT',
        amount: {
          value: ethers.parseEther(amount.toString()).toString(),
          currency: 'TLT',
          formatted: `${amount} TLT`
        },
        relatedEntities: {
          tlfId
        },
        metadata: {
          description: `Distribute payment for ${tlfId}`,
          function: 'distributePayment',
          paymentDetails: paymentEvent?.args
        },
        status: 'confirmed'
      });

      await transaction.save();

      return {
        success: true,
        tlfId,
        amount,
        transactionHash: tx.hash,
        paymentDetails: paymentEvent?.args
      };

    } catch (error) {
      logger.error(error, {
        context: 'distributePayment',
        tlfId,
        amount
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  // TLF 마켓플레이스에 등록
  async listTLF(tlfId, price, sellerAddress) {
    try {
      if (!this.contracts.Market) {
        throw new Error('Market contract not configured');
      }

      const tx = await this.contracts.Market.listTLF(
        tlfId,
        ethers.parseEther(price.toString())
      );

      const receipt = await tx.wait();

      const transaction = new Transaction({
        transactionId: `list_tlf_${Date.now()}`,
        blockchain: {
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          from: sellerAddress,
          to: tx.to,
          chainId: this.chainId,
          network: this.network,
          gasUsed: receipt.gasUsed.toString(),
          timestamp: new Date()
        },
        type: 'CONTRACT_CALL',
        amount: {
          value: '0',
          currency: 'ETH',
          formatted: '0 ETH'
        },
        relatedEntities: {
          tlfId
        },
        metadata: {
          description: `List TLF on marketplace: ${tlfId}`,
          function: 'listTLF',
          price
        },
        status: 'confirmed'
      });

      await transaction.save();

      return {
        success: true,
        tlfId,
        price,
        transactionHash: tx.hash,
        listingInfo: await this.getListingInfo(tlfId)
      };

    } catch (error) {
      logger.error(error, {
        context: 'listTLF',
        tlfId,
        price
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  // TLF 구매
  async buyTLF(tlfId, buyerAddress, price) {
    try {
      if (!this.contracts.Market) {
        throw new Error('Market contract not configured');
      }

      const tx = await this.contracts.Market.buyTLF(
        tlfId,
        { value: ethers.parseEther(price.toString()) }
      );

      const receipt = await tx.wait();

      const events = this.parseEvents(receipt, this.contracts.Market.interface);
      const saleEvent = events.find(e => e.name === 'TLFSold');

      const transaction = new Transaction({
        transactionId: `buy_tlf_${Date.now()}`,
        blockchain: {
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          from: buyerAddress,
          to: tx.to,
          chainId: this.chainId,
          network: this.network,
          gasUsed: receipt.gasUsed.toString(),
          timestamp: new Date()
        },
        type: 'TLF_PURCHASE',
        amount: {
          value: ethers.parseEther(price.toString()).toString(),
          currency: 'TLT',
          formatted: `${price} TLT`
        },
        relatedEntities: {
          tlfId
        },
        metadata: {
          description: `Buy TLF: ${tlfId}`,
          function: 'buyTLF',
          saleDetails: saleEvent?.args
        },
        status: 'confirmed'
      });

      await transaction.save();

      return {
        success: true,
        tlfId,
        price,
        buyer: buyerAddress,
        transactionHash: tx.hash,
        saleDetails: saleEvent?.args
      };

    } catch (error) {
      logger.error(error, {
        context: 'buyTLF',
        tlfId,
        buyerAddress
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  // 목록 정보 조회
  async getListingInfo(tlfId) {
    try {
      if (!this.contracts.Market) {
        throw new Error('Market contract not configured');
      }

      const listing = await this.contracts.Market.getListing(tlfId);
      
      return {
        seller: listing[0],
        price: ethers.formatEther(listing[1]),
        isListed: listing[2]
      };

    } catch (error) {
      logger.error(error, { context: 'getListingInfo', tlfId });
      return null;
    }
  }

  // TLT 토큰 전송
  async transferTLT(toAddress, amount, fromAddress = null) {
    try {
      if (!this.contracts.TLT) {
        throw new Error('TLT token contract not configured');
      }

      const value = ethers.parseEther(amount.toString());
      
      let tx;
      if (fromAddress && this.wallet && this.wallet.address.toLowerCase() !== fromAddress.toLowerCase()) {
        // 다른 주소에서 전송 (실제 구현에서는 서명 필요)
        throw new Error('Transfer from other addresses not implemented');
      } else {
        // 기본 지갑에서 전송
        tx = await this.contracts.TLT.transfer(toAddress, value);
      }

      const receipt = await tx.wait();

      const transaction = new Transaction({
        transactionId: `tlt_transfer_${Date.now()}`,
        blockchain: {
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          from: fromAddress || this.wallet?.address,
          to: toAddress,
          chainId: this.chainId,
          network: this.network,
          gasUsed: receipt.gasUsed.toString(),
          timestamp: new Date()
        },
        type: 'TLT_TRANSFER',
        amount: {
          value: value.toString(),
          currency: 'TLT',
          formatted: `${amount} TLT`
        },
        metadata: {
          description: `Transfer TLT to ${toAddress}`
        },
        status: 'confirmed'
      });

      await transaction.save();

      return {
        success: true,
        from: fromAddress || this.wallet?.address,
        to: toAddress,
        amount,
        transactionHash: tx.hash
      };

    } catch (error) {
      logger.error(error, {
        context: 'transferTLT',
        toAddress,
        amount
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  // 트랜잭션 이벤트 파싱
  parseEvents(receipt, contractInterface) {
    const events = [];
    
    for (const log of receipt.logs) {
      try {
        const parsedLog = contractInterface.parseLog(log);
        events.push({
          name: parsedLog.name,
          args: parsedLog.args,
          address: log.address,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash
        });
      } catch (error) {
        // 다른 컨트랙트의 로그일 수 있음
        continue;
      }
    }
    
    return events;
  }

  // 실패한 트랜잭션 기록
  async recordFailedTransaction(data) {
    try {
      const transaction = new Transaction({
        transactionId: `failed_${Date.now()}`,
        blockchain: {
          from: data.params?.creatorAddress || data.params?.viewerAddress || 'unknown',
          to: data.function ? 'contract' : 'unknown',
          chainId: this.chainId,
          network: this.network,
          timestamp: new Date()
        },
        type: data.type || 'CONTRACT_CALL',
        amount: {
          value: '0',
          currency: 'ETH',
          formatted: '0 ETH'
        },
        relatedEntities: {
          tlfId: data.params?.tlfId
        },
        metadata: {
          description: `Failed: ${data.function}`,
          function: data.function,
          parameters: data.params
        },
        status: 'failed',
        error: {
          message: data.error.message,
          code: data.error.code,
          details: data.error.details
        }
      });

      await transaction.save();
    } catch (error) {
      logger.error(error, { context: 'recordFailedTransaction' });
    }
  }

  // 가스비 추정
  async estimateGasCost(to, data, value = '0') {
    try {
      const gasEstimate = await this.provider.estimateGas({
        to,
        data,
        value: ethers.parseEther(value)
      });

      const feeData = await this.provider.getFeeData();

      return {
        gasEstimate: gasEstimate.toString(),
        gasPrice: ethers.formatUnits(feeData.gasPrice || 0, 'gwei'),
        maxFeePerGas: ethers.formatUnits(feeData.maxFeePerGas || 0, 'gwei'),
        maxPriorityFeePerGas: ethers.formatUnits(feeData.maxPriorityFeePerGas || 0, 'gwei'),
        estimatedCost: this.calculateGasCost(gasEstimate, feeData.gasPrice)
      };

    } catch (error) {
      logger.error(error, { context: 'estimateGasCost' });
      return {
        error: error.message
      };
    }
  }

  // 가스비 계산
  calculateGasCost(gasEstimate, gasPrice) {
    if (!gasPrice) return '0';
    
    const cost = gasEstimate * gasPrice;
    return ethers.formatEther(cost);
  }

  // 트랜잭션 상태 모니터링
  async monitorTransaction(txHash, confirmations = 12) {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      
      if (!receipt) {
        return {
          status: 'pending',
          confirmations: 0,
          requiredConfirmations: confirmations
        };
      }

      const currentBlock = await this.provider.getBlockNumber();
      const txConfirmations = receipt.blockNumber ? currentBlock - receipt.blockNumber + 1 : 0;

      return {
        status: receipt.status === 1 ? 'confirmed' : 'reverted',
        confirmations: txConfirmations,
        requiredConfirmations: confirmations,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        isConfirmed: txConfirmations >= confirmations
      };

    } catch (error) {
      logger.error(error, { context: 'monitorTransaction', txHash });
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  // 대기 중인 트랜잭션 처리
  async processPendingTransactions() {
    try {
      const pendingTxs = await Transaction.findPendingTransactions();
      const results = [];

      for (const tx of pendingTxs) {
        try {
          const status = await this.monitorTransaction(tx.blockchain.txHash);
          
          if (status.status === 'confirmed' && status.isConfirmed) {
            tx.confirm(status.confirmations);
            tx.complete();
            results.push({
              transactionId: tx.transactionId,
              status: 'completed',
              confirmations: status.confirmations
            });
          } else if (status.status === 'reverted' || status.status === 'error') {
            tx.fail({
              message: 'Transaction reverted or failed',
              blockchainError: status.error
            });
            results.push({
              transactionId: tx.transactionId,
              status: 'failed'
            });
          } else {
            // 아직 확인 중
            tx.confirm(status.confirmations || 0);
            results.push({
              transactionId: tx.transactionId,
              status: 'pending',
              confirmations: status.confirmations || 0
            });
          }

          await tx.save();

        } catch (error) {
          logger.error(error, {
            context: 'processPendingTransactions.single',
            transactionId: tx.transactionId
          });
          results.push({
            transactionId: tx.transactionId,
            status: 'error',
            error: error.message
          });
        }
      }

      return {
        processed: results.length,
        results
      };

    } catch (error) {
      logger.error(error, { context: 'processPendingTransactions' });
      return {
        processed: 0,
        error: error.message
      };
    }
  }

  // 블록체인 상태 체크
  async healthCheck() {
    try {
      const [networkInfo, walletInfo, pendingCount] = await Promise.all([
        this.getNetworkInfo(),
        this.getWalletInfo(),
        Transaction.countDocuments({ status: { $in: ['pending', 'processing'] } })
      ]);

      return {
        healthy: networkInfo.isConnected,
        network: networkInfo,
        wallet: walletInfo,
        pendingTransactions: pendingCount,
        timestamp: new Date()
      };

    } catch (error) {
      logger.error(error, { context: 'healthCheck' });
      return {
        healthy: false,
        error: error.message
      };
    }
  }
}

// 싱글톤 인스턴스
const blockchainService = new BlockchainService();

module.exports = blockchainService;

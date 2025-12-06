const tlfConverter = require('../services/tlf-converter');
const uploadService = require('../services/upload.service');
const cloudflareService = require('../services/cloudflare.service');
const File = require('../models/File');
const { validationResult } = require('express-validator');

exports.generateTLF = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { fileId } = req.params;
    const userId = req.user.id;

    // 파일 조회 및 권한 확인
    const file = await File.findOne({
      _id: fileId,
      creatorId: userId,
      status: 'ready'
    });

    if (!file) {
      return res.status(404).json({ 
        error: 'File not found or not ready for TLF generation' 
      });
    }

    // TLF 생성 데이터 준비
    const tlfData = {
      fileType: file.fileType,
      size: file.fileSize,
      duration: file.duration,
      format: file.originalName.split('.').pop(),
      originalName: file.originalName
    };

    const metadata = {
      title: file.title,
      description: file.description,
      creatorAddress: file.creatorAddress,
      pricePerMinute: file.pricePerMinute,
      isFree: file.isFree,
      createdAt: file.createdAt
    };

    // TLF 생성
    const tlfResult = await tlfConverter.convertToTLF(tlfData, metadata);

    // 파일에 TLF 정보 업데이트
    file.tlfId = tlfResult.tlfId;
    file.tlfHash = tlfResult.tlfHash;
    file.tlfObject = tlfResult.tlfObject;
    file.status = 'published';
    file.publishedAt = new Date();

    await file.save();

    res.status(201).json({
      success: true,
      message: 'TLF generated successfully',
      tlf: {
        id: tlfResult.tlfId,
        hash: tlfResult.tlfHash,
        fileHash: tlfResult.fileHash,
        timestamp: tlfResult.timestamp
      },
      file: {
        id: file._id,
        title: file.title,
        status: file.status,
        publishedAt: file.publishedAt
      }
    });

  } catch (error) {
    console.error('TLF generation error:', error);
    res.status(500).json({ 
      error: 'TLF generation failed', 
      details: error.message 
    });
  }
};

exports.verifyTLF = async (req, res) => {
  try {
    const { tlfId } = req.params;

    // 파일 조회
    const file = await File.findOne({ tlfId });
    
    if (!file || !file.tlfObject) {
      return res.status(404).json({ 
        error: 'TLF not found' 
      });
    }

    // 파일 데이터 가져오기 (실제로는 Cloudflare에서)
    const fileBuffer = Buffer.from('mock-file-data'); // 실제 구현에서는 파일 버퍼

    // TLF 검증
    const verificationResult = await tlfConverter.verifyTLF(
      file.tlfObject, 
      fileBuffer
    );

    res.json({
      success: true,
      tlfId,
      verification: verificationResult,
      fileInfo: {
        title: file.title,
        creator: file.creatorAddress,
        createdAt: file.createdAt,
        status: file.status
      }
    });

  } catch (error) {
    console.error('TLF verification error:', error);
    res.status(500).json({ 
      error: 'TLF verification failed', 
      details: error.message 
    });
  }
};

exports.getTLFInfo = async (req, res) => {
  try {
    const { tlfId } = req.params;

    const file = await File.findOne({ tlfId })
      .populate('creatorId', 'username walletAddress')
      .select('-__v -tlfObject');

    if (!file) {
      return res.status(404).json({ 
        error: 'TLF not found' 
      });
    }

    // 접근 권한 확인 (공개 파일이거나 소유자인 경우)
    const isOwner = req.user && 
                   (file.creatorId?._id.toString() === req.user.id || 
                    file.creatorAddress === req.user.address);
    
    const isPublic = file.status === 'published' && !file.isFree;
    
    if (!isOwner && !isPublic) {
      return res.status(403).json({ 
        error: 'Access denied' 
      });
    }

    // TLF 정보 추출
    const tlfMetadata = file.tlfObject ? 
      await tlfConverter.extractTLFMetadata(file.tlfObject) : null;

    // 통계 정보
    const stats = {
      views: file.viewCount,
      earnings: file.totalEarned,
      averageWatchTime: file.averageWatchTime
    };

    res.json({
      success: true,
      tlf: {
        id: file.tlfId,
        hash: file.tlfHash,
        createdAt: file.createdAt,
        metadata: tlfMetadata
      },
      content: {
        title: file.title,
        description: file.description,
        type: file.fileType,
        duration: file.duration,
        size: file.fileSize,
        pricePerMinute: file.pricePerMinute,
        isFree: file.isFree
      },
      creator: {
        id: file.creatorId?._id,
        username: file.creatorId?.username,
        address: file.creatorAddress
      },
      stats,
      access: {
        canPlay: isOwner || isPublic,
        canEdit: isOwner,
        canTransfer: isOwner
      }
    });

  } catch (error) {
    console.error('Get TLF info error:', error);
    res.status(500).json({ 
      error: 'Failed to get TLF info', 
      details: error.message 
    });
  }
};

exports.transferTLFOwnership = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { tlfId } = req.params;
    const { newOwnerAddress } = req.body;
    const userId = req.user.id;

    // 파일 및 소유권 확인
    const file = await File.findOne({ 
      tlfId, 
      creatorId: userId 
    });

    if (!file) {
      return res.status(404).json({ 
        error: 'TLF not found or you are not the owner' 
      });
    }

    // 새 소유자 확인 (사용자 존재 여부)
    // 실제 구현에서는 사용자 DB에서 확인

    // 블록체인에 소유권 이전 요청 (실제 구현에서는 스마트 컨트랙트 호출)
    console.log(`Transferring TLF ${tlfId} to ${newOwnerAddress}`);

    // 파일 정보 업데이트
    file.creatorAddress = newOwnerAddress.toLowerCase();
    file.updatedAt = new Date();
    
    // TODO: creatorId도 새 사용자로 업데이트 (사용자 DB에서 찾아서)

    await file.save();

    res.json({
      success: true,
      message: 'TLF ownership transferred',
      tlfId,
      previousOwner: req.user.address,
      newOwner: newOwnerAddress,
      transferredAt: new Date()
    });

  } catch (error) {
    console.error('TLF transfer error:', error);
    res.status(500).json({ 
      error: 'TLF transfer failed', 
      details: error.message 
    });
  }
};

exports.updateTLFPrice = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { tlfId } = req.params;
    const { pricePerMinute } = req.body;
    const userId = req.user.id;

    // 가격 검증
    const constants = require('../config/constants');
    if (pricePerMinute < constants.PRICING.MIN_PRICE_PER_MINUTE || 
        pricePerMinute > constants.PRICING.MAX_PRICE_PER_MINUTE) {
      return res.status(400).json({
        error: `Price must be between ${constants.PRICING.MIN_PRICE_PER_MINUTE} and ${constants.PRICING.MAX_PRICE_PER_MINUTE} TLT`
      });
    }

    // 파일 및 소유권 확인
    const file = await File.findOne({ 
      tlfId, 
      creatorId: userId 
    });

    if (!file) {
      return res.status(404).json({ 
        error: 'TLF not found or you are not the owner' 
      });
    }

    // 가격 업데이트
    const oldPrice = file.pricePerMinute;
    file.pricePerMinute = pricePerMinute;
    file.updatedAt = new Date();

    // TLF 객체 업데이트 (있는 경우)
    if (file.tlfObject) {
      file.tlfObject.pricing.pricePerMinute = pricePerMinute;
      // TLF 해시 재계산
      const tlfHash = tlfConverter.calculateTLFHash(file.tlfObject);
      file.tlfHash = tlfHash;
      file.tlfObject.tlfHash = tlfHash;
    }

    await file.save();

    res.json({
      success: true,
      message: 'TLF price updated',
      tlfId,
      oldPrice,
      newPrice: pricePerMinute,
      updatedAt: file.updatedAt
    });

  } catch (error) {
    console.error('TLF price update error:', error);
    res.status(500).json({ 
      error: 'TLF price update failed', 
      details: error.message 
    });
  }
};

exports.getTLFHistory = async (req, res) => {
  try {
    const { tlfId } = req.params;

    const file = await File.findOne({ tlfId })
      .select('tlfId title creatorAddress createdAt updatedAt status');

    if (!file) {
      return res.status(404).json({ 
        error: 'TLF not found' 
      });
    }

    // 재생 이력 조회 (실제 구현에서는 Play 모델에서)
    const playHistory = []; // 임시 데이터

    // 소유권 변경 이력 (실제 구현에서는 별도의 Ownership 모델에서)
    const ownershipHistory = [
      {
        owner: file.creatorAddress,
        from: file.createdAt,
        to: null,
        transaction: 'initial'
      }
    ];

    // 가격 변경 이력 (실제 구현에서는 PriceHistory 모델에서)
    const priceHistory = [
      {
        price: file.pricePerMinute,
        changedAt: file.updatedAt,
        changedBy: file.creatorAddress
      }
    ];

    res.json({
      success: true,
      tlfId,
      currentOwner: file.creatorAddress,
      currentPrice: file.pricePerMinute,
      status: file.status,
      history: {
        ownership: ownershipHistory,
        price: priceHistory,
        plays: playHistory
      },
      timeline: {
        created: file.createdAt,
        published: file.publishedAt,
        lastUpdated: file.updatedAt
      }
    });

  } catch (error) {
    console.error('Get TLF history error:', error);
    res.status(500).json({ 
      error: 'Failed to get TLF history' 
    });
  }
};

exports.bulkGenerateTLF = async (req, res) => {
  try {
    const { fileIds } = req.body;
    const userId = req.user.id;

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({
        error: 'File IDs array is required'
      });
    }

    if (fileIds.length > 10) {
      return res.status(400).json({
        error: 'Maximum 10 files per batch'
      });
    }

    const results = [];
    const errors = [];

    for (const fileId of fileIds) {
      try {
        const file = await File.findOne({
          _id: fileId,
          creatorId: userId,
          status: 'ready'
        });

        if (!file) {
          errors.push({
            fileId,
            error: 'File not found or not ready'
          });
          continue;
        }

        // TLF 생성 데이터 준비
        const tlfData = {
          fileType: file.fileType,
          size: file.fileSize,
          duration: file.duration,
          format: file.originalName.split('.').pop()
        };

        const metadata = {
          title: file.title,
          description: file.description,
          creatorAddress: file.creatorAddress,
          pricePerMinute: file.pricePerMinute,
          isFree: file.isFree
        };

        // TLF 생성
        const tlfResult = await tlfConverter.convertToTLF(tlfData, metadata);

        // 파일 업데이트
        file.tlfId = tlfResult.tlfId;
        file.tlfHash = tlfResult.tlfHash;
        file.tlfObject = tlfResult.tlfObject;
        file.status = 'published';
        file.publishedAt = new Date();

        await file.save();

        results.push({
          fileId,
          tlfId: tlfResult.tlfId,
          success: true
        });

      } catch (error) {
        errors.push({
          fileId,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: 'Batch TLF generation completed',
      summary: {
        total: fileIds.length,
        successful: results.length,
        failed: errors.length
      },
      results,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('Bulk TLF generation error:', error);
    res.status(500).json({ 
      error: 'Batch TLF generation failed', 
      details: error.message 
    });
  }
};

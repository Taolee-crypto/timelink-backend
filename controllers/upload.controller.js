const uploadService = require('../services/upload.service');
const tlfConverter = require('../services/tlf-converter');
const { validationResult } = require('express-validator');

exports.uploadFile = async (req, res) => {
  try {
    // 입력 검증
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { title, description, pricePerMinute, isFree } = req.body;
    const userId = req.user.id; // 인증 미들웨어에서 추가됨
    
    // 1. 파일 업로드 처리
    const uploadResult = await uploadService.handleUpload(req.file, {
      userId,
      title,
      description,
      pricePerMinute: parseFloat(pricePerMinute) || 0.1,
      isFree: isFree === 'true'
    });

    // 2. TLF 변환
    const tlfData = await tlfConverter.convertToTLF(uploadResult);
    
    // 3. 응답
    res.status(201).json({
      success: true,
      message: 'File uploaded successfully',
      data: {
        fileId: uploadResult.fileId,
        tlfId: tlfData.tlfId,
        tlfHash: tlfData.hash,
        previewUrl: uploadResult.previewUrl,
        estimatedProcessingTime: '2-5 minutes'
      }
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Upload failed', 
      details: error.message 
    });
  }
};

exports.getUploadStatus = async (req, res) => {
  try {
    const { fileId } = req.params;
    const status = await uploadService.getProcessingStatus(fileId);
    
    res.json({
      success: true,
      status: status.status,
      progress: status.progress,
      tlfId: status.tlfId,
      message: status.message
    });
    
  } catch (error) {
    res.status(404).json({ error: 'File not found' });
  }
};

exports.getUserFiles = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, status } = req.query;
    
    const files = await uploadService.getUserFiles(userId, {
      page: parseInt(page),
      limit: parseInt(limit),
      status
    });
    
    res.json({
      success: true,
      data: files,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: files.total
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch files' });
  }
};

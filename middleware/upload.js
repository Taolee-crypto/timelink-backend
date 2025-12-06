const multer = require('multer');
const path = require('path');

// 메모리 스토리지 (Cloudflare R2에 바로 업로드할 예정)
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'video/mp4', 'video/mov', 'video/avi', 'video/mkv',
    'audio/mp3', 'audio/wav', 'audio/flac', 'audio/m4a',
    'image/jpeg', 'image/png', 'image/gif',
    'application/pdf', 'text/plain', 'text/markdown'
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only video, audio, image, and document files are allowed.'));
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB
  }
});

// 파일 정보 추출 미들웨어
const extractFileInfo = (req, res, next) => {
  if (req.file) {
    req.fileInfo = {
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      buffer: req.file.buffer,
      extension: path.extname(req.file.originalname).toLowerCase()
    };
  }
  next();
};

module.exports = {
  single: upload.single('file'),
  array: upload.array('files', 5),
  extractFileInfo
};

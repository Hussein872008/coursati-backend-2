const multer = require('multer');
const path = require('path');
const fs = require('fs');

// إنشء مجلد uploads إذا لم يكن موجوداً
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// تكوين التخزين
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // تخزين في مجلد uploads مؤقتاً قبل الرفع إلى Cloudinary
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // اسم فريد للملف
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});


// تصفية الملفات
const fileFilter = (req, file, cb) => {
  // أنواع الملفات المسموحة (videos removed - video functionality has been removed from the project)
  const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const pdfTypes = ['application/pdf'];

  if (imageTypes.includes(file.mimetype) || 
      pdfTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('نوع الملف غير مدعوم'), false);
  }
};

// إعدادات multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 200 * 1024 * 1024 // 200MB
  }
});

module.exports = upload;

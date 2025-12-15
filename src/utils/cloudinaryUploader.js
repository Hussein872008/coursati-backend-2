const cloudinary = require('cloudinary').v2;

// Configure Cloudinary with credentials from .env
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload image to Cloudinary from URL or buffer
 * @param {string|Buffer} file - File URL or buffer
 * @param {string} folder - Cloudinary folder path
 * @param {string} publicId - Optional public ID
 * @returns {Promise<Object>} Cloudinary response with secure_url
 */
const uploadImage = async (file, folder = 'coursati/images', publicId = null) => {
  try {
    const options = {
      folder,
      resource_type: 'auto',
      quality: 'auto',
    };

    if (publicId) {
      options.public_id = publicId;
    }

    let result;

    // If file is a URL, upload from URL
    if (typeof file === 'string' && file.startsWith('http')) {
      result = await cloudinary.uploader.upload(file, options);
    } else if (typeof file === 'string') {
      // If it's a file path, upload from path
      result = await cloudinary.uploader.upload(file, options);
    } else {
      // If it's a buffer, upload from stream
      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
        uploadStream.end(file);
      });
    }

    return {
      success: true,
      url: result.secure_url,
      public_id: result.public_id,
      format: result.format,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
    };
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Upload PDF to Cloudinary
 * @param {string|Buffer} file - File URL or buffer
 * @param {string} folder - Cloudinary folder path
 * @returns {Promise<Object>} Cloudinary response with secure_url
 */
const uploadPDF = async (file, folder = 'coursati/pdfs') => {
  try {
    const options = {
      folder,
      resource_type: 'raw',
    };

    let result;

    if (typeof file === 'string' && file.startsWith('http')) {
      result = await cloudinary.uploader.upload(file, options);
    } else if (typeof file === 'string') {
      result = await cloudinary.uploader.upload(file, options);
    } else {
      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
        uploadStream.end(file);
      });
    }

    return {
      success: true,
      url: result.secure_url,
      public_id: result.public_id,
      format: result.format,
      bytes: result.bytes,
    };
  } catch (error) {
    console.error('Cloudinary PDF upload error:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Upload video segment to Cloudinary
 * REMOVED - video functionality has been removed from the project
 */
const uploadVideo = async (file, folder = 'coursati/videos') => {
  throw new Error('Video upload functionality has been removed from the project');
};

/**
 * Delete file from Cloudinary
 * @param {string} publicId - Public ID of the file
 * @param {string} resourceType - Type of resource (image, raw, video)
 * @returns {Promise<Object>} Cloudinary response
 */
const deleteFile = async (publicId, resourceType = 'image') => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
    });

    return {
      success: result.result === 'ok',
      result,
    };
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Get image transformation URL
 * @param {string} url - Original Cloudinary URL
 * @param {Object} transformations - Transformation options
 * @returns {string} Transformed URL
 */
const getTransformedUrl = (url, transformations = {}) => {
  // Example: {width: 300, height: 300, crop: 'fill', quality: 'auto'}
  if (!url) return '';

  const defaults = {
    quality: 'auto',
    fetch_format: 'auto',
    ...transformations,
  };

  const params = Object.entries(defaults)
    .map(([key, value]) => `${key}_${value}`)
    .join(',');

  // Convert URL to use transformation
  return url.replace('/upload/', `/upload/${params}/`);
};

module.exports = {
  cloudinary,
  uploadImage,
  uploadPDF,
  uploadVideo,
  deleteFile,
  getTransformedUrl,
};

/**
 * Try to extract Cloudinary public_id from a secure URL.
 * Handles URLs like:
 *  - https://res.cloudinary.com/<cloud>/image/upload/v123456/folder/sub/id.jpg
 *  - https://res.cloudinary.com/<cloud>/image/upload/q_auto,f_auto/v123/.../folder/id.png
 */
const getPublicIdFromUrl = (url) => {
  if (!url || typeof url !== 'string') return null;
  try {
    const parts = url.split('/upload/');
    if (parts.length < 2) return null;
    const afterUpload = parts[1];
    // remove transformations and version prefix: find '/v' followed by digits and a slash
    const vMatch = afterUpload.match(/\/v\d+\//);
    let publicPath = afterUpload;
    if (vMatch && vMatch.index != null) {
      publicPath = afterUpload.slice(vMatch.index + vMatch[0].length);
    }
    // remove file extension and any query params
    publicPath = publicPath.split('?')[0];
    const lastDot = publicPath.lastIndexOf('.');
    if (lastDot > -1) publicPath = publicPath.slice(0, lastDot);
    // Trim any leading/trailing slashes
    publicPath = publicPath.replace(/^\/+|\/+$/g, '');
    return publicPath || null;
  } catch (e) {
    return null;
  }
};

// export helper
module.exports.getPublicIdFromUrl = getPublicIdFromUrl;

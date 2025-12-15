const mongoose = require('mongoose');

function getBucket() {
  if (!mongoose.connection || !mongoose.connection.db) {
    throw new Error('MongoDB connection not ready for GridFS');
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'fs' });
}

async function findFileByName(filename) {
  const bucket = getBucket();
  const files = await bucket.find({ filename }).toArray();
  return files && files.length ? files[0] : null;
}

async function uploadStreamFromStream(videoId, quality, segmentNumber, readStream, contentType) {
  const bucket = getBucket();
  const filename = `videos/${videoId}/${quality}/segment-${segmentNumber}.ts`;
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, { contentType });
    readStream.pipe(uploadStream)
      .on('finish', () => resolve({ fileId: uploadStream.id, filename }))
      .on('error', (err) => reject(err));
  });
}

function openDownloadStreamById(id) {
  const bucket = getBucket();
  return bucket.openDownloadStream(id);
}

function openDownloadStreamByName(filename) {
  const bucket = getBucket();
  return bucket.openDownloadStreamByName(filename);
}

module.exports = {
  findFileByName,
  uploadStreamFromStream,
  openDownloadStreamById,
  openDownloadStreamByName,
};

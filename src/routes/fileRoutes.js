const express = require('express');
const router = express.Router();
const {
    uploadFiles,
    getFiles,
    downloadFile,
    deleteFile,
    deleteMultipleFiles,
    viewFile,
    createFolder,
    compressFiles,
    decompressFile,
    renameItem,
    moveItem,
    download,
    getFileSize,
    getUploadStatus,
    stopCompression,
    getFolderTree,
    setPassword,
    removePassword,
    verifyPassword,
    searchItems
} = require('../controllers/fileController');

const multer = require('multer');

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/upload', upload.single('chunk'), uploadFiles);
router.get('/', getFiles);
// router.get('/download/:name', downloadFile);
router.delete('/:id', deleteFile);
router.delete('/', deleteMultipleFiles);
router.get('/view/:fileId', viewFile);
router.post('/create-folder', createFolder);
router.post('/compress', compressFiles);
router.post('/decompress', decompressFile);
router.post('/rename', renameItem);
router.post('/move', moveItem);
router.post('/download', download);
router.post('/file-size', getFileSize);
router.get('/upload/status', getUploadStatus);
router.post('/stop-compression', stopCompression);
router.get('/folders/tree', getFolderTree);

// Search files and folders
router.get('/search', searchItems);

// Password protection routes
router.post('/password/set', setPassword);
router.post('/password/remove', removePassword);
router.post('/password/verify', verifyPassword);

module.exports = router;
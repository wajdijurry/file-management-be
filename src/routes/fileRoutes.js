const express = require('express');
const router = express.Router();
const {
    uploadFiles,
    getFiles,
    // downloadFile,
    deleteFile,
    deleteMultipleFiles,
    viewFile,
    createFolder,
    compressFiles,
    decompressFile,
    renameItem,
    moveItem,
    download,
    getFileSize
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

module.exports = router;
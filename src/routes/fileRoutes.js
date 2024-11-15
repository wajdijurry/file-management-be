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

const upload = multer(); // Initialize multer with no storage option to handle file buffers

router.post('/upload', upload.array('files'), uploadFiles);
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
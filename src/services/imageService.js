const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const File = require('../models/fileModel');
const mime = require('mime');

class ImageService {
    static uploadDirectory = path.join(__dirname, '../../public/uploads');

    static async convertImage(fileId, targetFormat, quality = 100) {
        const originalFile = await File.findById(fileId);
        if (!originalFile) throw new Error('Source file not found.');

        targetFormat = targetFormat.toLowerCase();

        if (!['png', 'jpg', 'jpeg', 'webp', 'avif'].includes(targetFormat)) {
            throw new Error('Invalid target format.');
        }

        // const originalFilePath = path.join(this.uploadDirectory, path.basename(originalFile.path));
        const outputFileName = `${path.basename(originalFile.name, path.extname(originalFile.name))}-converted-${Date.now()}.${targetFormat}`;
        const outputFilePath = path.join(path.dirname(originalFile.path), outputFileName);
        const absoulteInputFilePath = path.join(this.uploadDirectory, originalFile.path);
        const absoluteOutputFilePath = path.join(this.uploadDirectory, outputFilePath);

        console.log(outputFileName, outputFilePath, absoulteInputFilePath, absoluteOutputFilePath);
        

        if (!fs.existsSync(absoulteInputFilePath)) throw new Error('File not found.');

        try {
            // Perform the image conversion
            await sharp(absoulteInputFilePath)
                .toFormat(targetFormat, { quality: parseInt(quality) || 100 })
                .toFile(absoluteOutputFilePath);

            const fileStats = fs.statSync(absoluteOutputFilePath);
            const mimeType = mime.getType(absoluteOutputFilePath);

            const newFile = new File({
                name: outputFileName,
                path: outputFilePath,
                mimetype: mimeType,
                size: fileStats.size,
                userId: originalFile.userId,
                parent_id: originalFile.parent_id
            });

            await newFile.save();

            return {
                message: 'Image converted successfully.',
                filePath: `/uploads/${outputFileName}`
            };
        } catch (error) {
            console.error('Image conversion failed:', error);
            throw new Error('Image conversion failed.');
        }
    }
}

module.exports = ImageService;
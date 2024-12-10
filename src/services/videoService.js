const fs = require('fs');
const path = require('path');
const File = require('../models/fileModel');  // Correct model path

class VideoService {
    static uploadDirectory = path.join(__dirname, '../../public/uploads');

    static async getVideoDetails(fileId) {
        const video = await File.findById(fileId);
        
        if (!video) return null;

        const videoPath = path.join(this.uploadDirectory, video.path);
        return fs.existsSync(videoPath) ? { path: videoPath, size: fs.statSync(videoPath).size } : null;
    }
}

module.exports = VideoService;

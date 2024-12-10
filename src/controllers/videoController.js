const VideoService = require('../services/videoService');
const fs = require('fs');

exports.streamVideo = async (req, res) => {
    const { fileId } = req.params;

    // Fetch Video Stream
    const video = await VideoService.getVideoDetails(fileId);  // Fetch file details
    if (!video) {
        return res.status(404).send('Video not found');
    }

    const videoPath = video.path;
    const videoSize = fs.statSync(videoPath).size;
    const range = req.headers.range;

    if (!range) {
        // Full Content Response
        const headers = {
            'Content-Length': videoSize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(200, headers);
        fs.createReadStream(videoPath).pipe(res);
        return;
    }

    // Partial Content Response
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : videoSize - 1;

    if (start >= videoSize || end >= videoSize) {
        res.status(416).send('Requested range not satisfiable');
        return;
    }

    const chunkSize = end - start + 1;
    const videoStream = fs.createReadStream(videoPath, { start, end });

    const headers = {
        'Content-Range': `bytes ${start}-${end}/${videoSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
    };

    res.writeHead(206, headers);  // Status 206: Partial Content
    videoStream.pipe(res);
};

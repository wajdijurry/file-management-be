const mongoose = require('mongoose');

const uploadProgressSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    filename: { type: String, required: true },
    uploadedChunks: { type: [Number], default: [] }, // List of chunk indices already uploaded
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('UploadProgress', uploadProgressSchema);

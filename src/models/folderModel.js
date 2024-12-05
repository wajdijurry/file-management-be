const mongoose = require('mongoose');

const folderSchema = new mongoose.Schema({
    name: { type: String, required: true },
    path: { type: String, required: true },
    userId: { type: String, ref: 'User', required: true },
    parent_id: { type: String, default: null },
    deleted: { type: Boolean, default: false },
    isPasswordProtected: { type: Boolean, default: false },
    password: { type: String, select: false }, // Will not be included in queries by default
    lastAccessed: { type: Date },
    createdAt: { type: Date, default: Date.now },
    fileCount: { type: Number, default: 0 },
    folderCount: { type: Number, default: 0 },
    size: { type: Number, default: 0 }
});

// Virtual field `isFolder` to indicate that the document is a folder
folderSchema.virtual('isFolder').get(function() {
    return true;
});

folderSchema.set('toJSON', { virtuals: true });
folderSchema.set('toObject', { virtuals: true });

// Add index for faster queries
folderSchema.index({ userId: 1, parent_id: 1, deleted: 1 });

// Middleware to check and reset lastAccessed if more than 1 hour old
folderSchema.pre('save', function(next) {
    if (this.lastAccessed) {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000); // 1 hour in milliseconds
        if (this.lastAccessed < oneHourAgo) {
            this.lastAccessed = null;
        }
    }
    next();
});

module.exports = mongoose.model('Folder', folderSchema);

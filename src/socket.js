// socket.js
let io;

module.exports = {
    init: (server, corsOptions) => {
        if (io) {
            throw new Error('Socket.IO is already initialized!');
        }
        io = require('socket.io')(server, {
            cors: corsOptions,
        });
        return io;
    },
    getIO: () => {
        if (!io) {
            throw new Error('Socket.IO is not initialized!');
        }
        return io;
    },
};

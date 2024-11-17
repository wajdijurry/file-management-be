const express = require('express');
const cors = require('cors');
const { init } = require('./socket'); // Import the socket singleton
const fileRoutes = require('./routes/fileRoutes');
const auth = require('./middlewares/auth');
const authRoutes = require('./routes/authRoutes');
const connectDB = require('./config/db');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

const corsOptions = {
    origin: 'http://localhost:8082', // Allow only your frontend's origin
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Allow these methods
    allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with', 'Range'], // Allow required headers
    optionsSuccessStatus: 200 // For legacy browser support
};

// Create an HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = init(server, corsOptions); // Initialize Socket.IO


// Set up WebSocket logic
// io.on('connection', (socket) => {
//     console.log('A user connected:', socket.id);
//
//     // Example event
//     socket.on('message', (data) => {
//         console.log('Message received:', data);
//         socket.emit('response', 'Message received'); // Echo back
//     });
//
//     socket.on('disconnect', () => {
//         console.log('A user disconnected:', socket.id);
//     });
// });

io.use((socket, next) => {
    const token = socket.handshake.auth.token; // Retrieve the token
    if (!token) {
        return next(new Error('Authentication error: Token missing'));
    }

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET); // Verify the token
        socket.userId = payload.userId; // Attach userId to the socket
        next();
    } catch (err) {
        return next(new Error('Authentication error: Invalid token'));
    }
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('joinRoom', (userId) => {
        socket.join(userId); // Join the room
        console.log(`User ${socket.id} joined room ${userId}`);
    });
});

app.use(cors(corsOptions));

// Handle preflight requests for all routes
app.options('*', cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to MongoDB
connectDB();

// Routes
app.use('/api/files', auth, fileRoutes);
app.use('/api/auth', authRoutes);

// Start the server
// app.listen(PORT, () => {
//     console.log(`Server is running on port ${PORT}`);
// });

// Start the server
server.listen(PORT, () => { // Use `server.listen` instead of `app.listen`
    console.log(`Server is running on port ${PORT}`);
});
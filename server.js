const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {}; // roomId -> Set of socket ids

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join a room
  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userName = userName || 'Guest';

    if (!rooms[roomId]) rooms[roomId] = new Set();
    rooms[roomId].add(socket.id);

    // Tell the new user about existing peers
    const peers = [...rooms[roomId]].filter(id => id !== socket.id);
    socket.emit('existing-peers', { peers });

    // Tell existing peers about the new user
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userName: socket.data.userName
    });

    console.log(`${socket.data.userName} joined room ${roomId}`);
  });

  // WebRTC signaling: offer
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', {
      from: socket.id,
      userName: socket.data.userName,
      offer
    });
  });

  // WebRTC signaling: answer
  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', {
      from: socket.id,
      answer
    });
  });

  // WebRTC signaling: ICE candidate
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', {
      from: socket.id,
      candidate
    });
  });

  // Chat message
  socket.on('chat-message', ({ roomId, message }) => {
    const payload = {
      socketId: socket.id,
      userName: socket.data.userName,
      message,
      timestamp: new Date().toISOString()
    };
    io.to(roomId).emit('chat-message', payload);
  });

  // Media state (mute/video toggle)
  socket.on('media-state', ({ roomId, audio, video }) => {
    socket.to(roomId).emit('peer-media-state', {
      socketId: socket.id,
      audio,
      video
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const { roomId } = socket.data;
    if (roomId && rooms[roomId]) {
      rooms[roomId].delete(socket.id);
      if (rooms[roomId].size === 0) delete rooms[roomId];
      io.to(roomId).emit('user-left', { socketId: socket.id });
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎥 VideoConf server running at http://localhost:${PORT}\n`);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── Static files ─────────────────────────────────────────────
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  console.error('\n❌  ERROR: "public/" folder not found next to server.js\n');
}
app.use(express.static(publicDir));
app.get('/', (req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  fs.existsSync(indexPath)
    ? res.sendFile(indexPath)
    : res.status(404).send('index.html not found inside public/ folder.');
});

// ── ICE / TURN credentials endpoint ──────────────────────────
// Called by the client before creating a peer connection.
// Uses Metered.ca free TURN — set METERED_API_KEY in Railway env vars.
app.get('/ice-servers', async (req, res) => {
  try {
    const response = await fetch(
      'https://talknet.metered.live/api/v1/turn/credentials?apiKey=c66ed9fc4cca4aec24e42b773c5f42c0696f'
    );
    const iceServers = await response.json();
    res.json(iceServers);
  } catch (err) {
    console.error('Failed to fetch TURN credentials:', err.message);
    res.json([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]);
  }
});

// ── Rooms ─────────────────────────────────────────────────────
const rooms = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userName = userName || 'Guest';

    if (!rooms[roomId]) rooms[roomId] = new Set();
    rooms[roomId].add(socket.id);

    const peers = [...rooms[roomId]].filter(id => id !== socket.id);
    socket.emit('existing-peers', { peers });
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userName: socket.data.userName
    });
    console.log(`${socket.data.userName} joined room ${roomId}`);
  });

  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, userName: socket.data.userName, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('chat-message', ({ roomId, message }) => {
    io.to(roomId).emit('chat-message', {
      socketId: socket.id,
      userName: socket.data.userName,
      message,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('media-state', ({ roomId, audio, video }) => {
    socket.to(roomId).emit('peer-media-state', { socketId: socket.id, audio, video });
  });

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
  console.log(`\n🎥 VideoConf running at http://localhost:${PORT}\n`);
});

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

// In-memory room manager
const rooms = {};

const ROLES = [
  { role: 'Raja', points: 1000, emoji: '👑' },
  { role: 'Mantri', points: 800, emoji: '📜' },
  { role: 'Sipahi', points: 500, emoji: '⚔️' },
  { role: 'Chor', points: 0, emoji: '🎭' }
];

function shuffleArray(arr) {
  const array = [...arr];
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create_room', ({ playerName }) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      round: 1,
      players: [
        { id: socket.id, seat: 1, name: playerName || 'Player 1', score: 0, role: null }
      ],
      gameState: 'WAITING', // WAITING, DEALT, GUESSING, ROUND_OVER
      chits: {}
    };

    socket.join(roomCode);
    currentRoom = roomCode;
    socket.emit('room_created', { roomCode, seat: 1 });
    io.to(roomCode).emit('room_update', rooms[roomCode]);
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    const cleanCode = (roomCode || '').trim().toUpperCase();
    const room = rooms[cleanCode];

    if (!room) {
      return socket.emit('error_message', 'Room not found!');
    }
    if (room.players.length >= 4) {
      return socket.emit('error_message', 'Room is already full (Max 4 Players)!');
    }

    const seat = room.players.length + 1;
    room.players.push({
      id: socket.id,
      seat: seat,
      name: playerName || `Player ${seat}`,
      score: 0,
      role: null
    });

    socket.join(cleanCode);
    currentRoom = cleanCode;
    socket.emit('room_joined', { roomCode: cleanCode, seat });
    io.to(cleanCode).emit('room_update', room);
  });

  socket.on('rename_player', ({ newName }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players.find(p => p.id === socket.id);
    if (player && newName.trim()) {
      player.name = newName.trim();
      io.to(currentRoom).emit('room_update', room);
    }
  });

  // Server-side secret deal
  socket.on('start_round', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.hostId !== socket.id) return;
    if (room.players.length !== 4) {
      return socket.emit('error_message', 'Need exactly 4 players to deal royal chits!');
    }

    const shuffled = shuffleArray(ROLES);
    room.chits = {};
    room.gameState = 'DEALT';

    room.players.forEach((player, idx) => {
      player.role = shuffled[idx];
      room.chits[player.id] = shuffled[idx];
      // Send ONLY their assigned role secretly
      io.to(player.id).emit('your_secret_chit', {
        role: shuffled[idx].role,
        points: shuffled[idx].points,
        emoji: shuffled[idx].emoji
      });
    });

    io.to(currentRoom).emit('chits_dealt', {
      round: room.round,
      players: room.players.map(p => ({ id: p.id, seat: p.seat, name: p.name, score: p.score }))
    });
  });

  socket.on('call_court', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const raja = room.players.find(p => p.role.role === 'Raja');
    const mantri = room.players.find(p => p.role.role === 'Mantri');

    room.gameState = 'GUESSING';
    io.to(currentRoom).emit('court_called', {
      raja: { id: raja.id, name: raja.name },
      mantri: { id: mantri.id, name: mantri.name }
    });
  });

  socket.on('submit_guess', ({ suspectId }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const mantri = room.players.find(p => p.role.role === 'Mantri');
    const chor = room.players.find(p => p.role.role === 'Chor');
    const sipahi = room.players.find(p => p.role.role === 'Sipahi');
    const raja = room.players.find(p => p.role.role === 'Raja');

    if (socket.id !== mantri.id) return; // Only Mantri can submit a guess

    const isCorrect = suspectId === chor.id;

    raja.score += 1000;
    sipahi.score += 500;

    if (isCorrect) {
      mantri.score += 800;
      chor.score += 0;
    } else {
      chor.score += 800;
      mantri.score += 0;
    }

    room.gameState = 'ROUND_OVER';
    room.round += 1;

    // Reveal all cards simultaneously to everyone
    io.to(currentRoom).emit('round_result', {
      isCorrect,
      mantriName: mantri.name,
      chorName: chor.name,
      revealedRoles: room.players.map(p => ({
        id: p.id,
        name: p.name,
        role: p.role.role,
        emoji: p.role.emoji,
        points: p.role.points
      })),
      players: room.players.map(p => ({ id: p.id, seat: p.seat, name: p.name, score: p.score })),
      nextRound: room.round
    });
  });

  // WebRTC Audio Mesh Signaling
  socket.on('webrtc_signal', ({ targetId, signal }) => {
    io.to(targetId).emit('webrtc_signal', {
      senderId: socket.id,
      signal
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[currentRoom];
      } else {
        if (room.hostId === socket.id) room.hostId = room.players[0].id;
        io.to(currentRoom).emit('room_update', room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Raja Mantri Online Server running on http://localhost:${PORT}`);
});
/* ════════════════════════════════════════════════════════════
   VideoConf — Client Script (Socket.IO CDN-safe version)
   ════════════════════════════════════════════════════════════ */

// Wait for Socket.IO to be available (handles CDN async fallback)
function waitForIO(cb) {
  if (typeof io !== 'undefined') return cb();
  const t = setInterval(() => {
    if (typeof io !== 'undefined') { clearInterval(t); cb(); }
  }, 50);
}

// ── State ────────────────────────────────────────────────────
let socket;
let localStream = null;
let screenStream = null;
let myName = '';
let roomId = '';
let peers = {};
let peerNames = {};
let audioEnabled = true;
let videoEnabled = true;
let isSharingScreen = false;
let mainSocketId = 'self';
let unreadCount = 0;
let chatOpen = false;
let timerInterval = null;

// ── DOM refs ─────────────────────────────────────────────────
const joinScreen       = document.getElementById('join-screen');
const meetingRoom      = document.getElementById('meeting-room');
const nameInput        = document.getElementById('name-input');
const roomInput        = document.getElementById('room-input');
const joinBtn          = document.getElementById('join-btn');
const mainVideo        = document.getElementById('main-video');
const mainLabel        = document.getElementById('main-label');
const mainStatus       = document.getElementById('main-status');
const mainWrapper      = document.getElementById('main-video-wrapper');
const strip            = document.getElementById('participants-strip');
const roomLabel        = document.getElementById('room-label');
const participantCount = document.getElementById('participant-count');
const toggleAudioBtn   = document.getElementById('toggle-audio-btn');
const toggleVideoBtn   = document.getElementById('toggle-video-btn');
const chatBtn          = document.getElementById('chat-btn');
const leaveBtn         = document.getElementById('leave-btn');
const shareScreenBtn   = document.getElementById('share-screen-btn');
const inviteBtn        = document.getElementById('invite-btn');
const chatPanel        = document.getElementById('chat-panel');
const closeChatBtn     = document.getElementById('close-chat-btn');
const chatMessages     = document.getElementById('chat-messages');
const chatInput        = document.getElementById('chat-input');
const sendBtn          = document.getElementById('send-btn');
const chatBadge        = document.getElementById('chat-badge');
const timerEl          = document.getElementById('meeting-timer');

// ICE servers are fetched from the server (includes TURN when configured)
let iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

async function loadIceServers() {
  try {
    const res = await fetch('/ice-servers');
    const servers = await res.json();
    iceConfig = { iceServers: servers };
    console.log('ICE servers loaded:', servers.length, 'servers');
  } catch (e) {
    console.warn('Could not load ICE servers, using STUN only:', e.message);
  }
}

// ════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ════════════════════════════════════════════════════════════
waitForIO(() => {
  socket = io();

  socket.on('existing-peers', async ({ peers: existingPeers }) => {
    for (const peerId of existingPeers) {
      const pc = createPeerConnection(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, offer });
    }
  });

  socket.on('user-joined', ({ socketId, userName }) => {
    peerNames[socketId] = userName;
    toast(`${userName} joined the meeting`);
    updateParticipantCount();
  });

  socket.on('offer', async ({ from, userName, offer }) => {
    peerNames[from] = userName;
    const pc = createPeerConnection(from);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, answer });
    updateParticipantCount();
  });

  socket.on('answer', async ({ from, answer }) => {
    const pc = peers[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    const pc = peers[from];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  });

  socket.on('user-left', ({ socketId }) => {
    const name = peerNames[socketId] || 'Someone';
    toast(`${name} left the meeting`);
    removePeer(socketId);
    updateParticipantCount();
  });

  socket.on('peer-media-state', ({ socketId, audio }) => {
    updateTileMutedIcon(socketId, !audio);
    if (socketId === mainSocketId) updateMainMutedStatus(!audio);
  });

  socket.on('chat-message', ({ socketId, userName, message, timestamp }) => {
    const isSelf = socketId === socket.id;
    appendMessage(userName, message, timestamp, isSelf);
    if (!chatOpen && !isSelf) {
      unreadCount++;
      chatBadge.textContent = unreadCount;
      chatBadge.classList.remove('hidden');
    }
  });

  // Join
  joinBtn.addEventListener('click', joinMeeting);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') roomInput.focus(); });
  roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinMeeting(); });

  async function joinMeeting() {
    myName = nameInput.value.trim() || 'Guest';
    roomId = roomInput.value.trim() || 'default-room';
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      toast('Camera/mic not available — trying audio only.', 4000);
      try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch { localStream = new MediaStream(); }
    }
    joinScreen.classList.add('hidden');
    meetingRoom.classList.remove('hidden');
    roomLabel.textContent = roomId;
    showSelfInMain();
    addSelfTile();
    startTimer();

    // Fetch TURN credentials before signaling starts
    await loadIceServers();
    socket.emit('join-room', { roomId, userName: myName });
  }

  // Audio
  toggleAudioBtn.addEventListener('click', () => {
    audioEnabled = !audioEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = audioEnabled);
    toggleAudioBtn.querySelector('.icon-mic-on').classList.toggle('hidden', !audioEnabled);
    toggleAudioBtn.querySelector('.icon-mic-off').classList.toggle('hidden', audioEnabled);
    toggleAudioBtn.classList.toggle('muted', !audioEnabled);
    toggleAudioBtn.querySelector('span').textContent = audioEnabled ? 'Mute' : 'Unmute';
    if (mainSocketId === 'self') updateMainMutedStatus(!audioEnabled);
    updateTileMutedIcon('self', !audioEnabled);
    socket.emit('media-state', { roomId, audio: audioEnabled, video: videoEnabled });
  });

  // Video
  toggleVideoBtn.addEventListener('click', () => {
    videoEnabled = !videoEnabled;
    localStream.getVideoTracks().forEach(t => t.enabled = videoEnabled);
    toggleVideoBtn.querySelector('.icon-vid-on').classList.toggle('hidden', !videoEnabled);
    toggleVideoBtn.querySelector('.icon-vid-off').classList.toggle('hidden', videoEnabled);
    toggleVideoBtn.classList.toggle('muted', !videoEnabled);
    toggleVideoBtn.querySelector('span').textContent = videoEnabled ? 'Stop Video' : 'Start Video';
    const selfTile = document.getElementById('tile-self');
    if (selfTile) {
      const overlay = selfTile.querySelector('.tile-avatar');
      if (overlay) overlay.style.display = videoEnabled ? 'none' : 'flex';
    }
    if (mainSocketId === 'self') updateMainAvatarOverlay('self');
    socket.emit('media-state', { roomId, audio: audioEnabled, video: videoEnabled });
  });

  // Screen share
  shareScreenBtn.addEventListener('click', async () => {
    if (isSharingScreen) { stopScreenShare(); return; }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      for (const pc of Object.values(peers)) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      }
      const selfTileVideo = document.querySelector('#tile-self video');
      if (selfTileVideo) selfTileVideo.srcObject = screenStream;
      if (mainSocketId === 'self') mainVideo.srcObject = screenStream;
      isSharingScreen = true;
      shareScreenBtn.classList.add('sharing');
      shareScreenBtn.querySelector('span').textContent = 'Stop Share';
      toast('Screen sharing started');
      screenTrack.onended = stopScreenShare;
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast('Could not start screen share');
    }
  });

  // Leave
  leaveBtn.addEventListener('click', () => {
    for (const pc of Object.values(peers)) pc.close();
    localStream && localStream.getTracks().forEach(t => t.stop());
    clearInterval(timerInterval);
    socket.disconnect();
    location.reload();
  });

  // Chat
  chatBtn.addEventListener('click', () => toggleChat(true));
  closeChatBtn.addEventListener('click', () => toggleChat(false));
  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Invite
  inviteBtn.addEventListener('click', () => {
    const url = `${location.origin}?room=${encodeURIComponent(roomId)}`;
    navigator.clipboard.writeText(url).then(() => toast('Invite link copied!'));
  });

  function sendMessage() {
    const msg = chatInput.value.trim();
    if (!msg) return;
    socket.emit('chat-message', { roomId, message: msg });
    chatInput.value = '';
  }

  function createPeerConnection(peerId) {
    if (peers[peerId]) return peers[peerId];
    const pc = new RTCPeerConnection(iceConfig);
    peers[peerId] = pc;
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('ice-candidate', { to: peerId, candidate });
    };
    const remoteStream = new MediaStream();
    pc.ontrack = ({ track, streams }) => {
      // Prefer the stream that comes with the track if available
      const sourceStream = (streams && streams[0]) ? streams[0] : remoteStream;
      if (!sourceStream.getTracks().includes(track)) {
        sourceStream.addTrack(track);
      }
      // Always refresh the tile so it picks up the new track
      addOrUpdateRemoteTile(peerId, sourceStream);

      // When this track ends, re-check the tile
      track.onended = () => addOrUpdateRemoteTile(peerId, sourceStream);
    };
    pc.onconnectionstatechange = () => {
      if (['disconnected','failed','closed'].includes(pc.connectionState)) removePeer(peerId);
    };
    return pc;
  }

  function addOrUpdateRemoteTile(peerId, stream) {
    let tile = document.getElementById(`tile-${peerId}`);
    if (!tile) {
      const name = peerNames[peerId] || 'Participant';
      tile = buildTile(peerId, stream, name, false);
      strip.appendChild(tile);
    } else {
      // Tile exists — refresh the video element's srcObject so it picks up new tracks
      const video = tile.querySelector('video');
      if (video) {
        video.srcObject = null;
        video.srcObject = stream;
        video.play().catch(() => {});
      }
      // Hide avatar since we now have a stream
      const overlay = tile.querySelector('.tile-avatar');
      if (overlay) overlay.style.display = 'none';
    }
    if (mainSocketId === peerId) mainVideo.srcObject = stream;
    updateParticipantCount();
  }

  function removePeer(peerId) {
    if (peers[peerId]) { peers[peerId].close(); delete peers[peerId]; }
    delete peerNames[peerId];
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) tile.remove();
    if (mainSocketId === peerId) showSelfInMain();
    updateParticipantCount();
  }

  function stopScreenShare() {
    if (!isSharingScreen) return;
    screenStream && screenStream.getTracks().forEach(t => t.stop());
    const camTrack = localStream.getVideoTracks()[0];
    for (const pc of Object.values(peers)) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && camTrack) sender.replaceTrack(camTrack);
    }
    const selfTileVideo = document.querySelector('#tile-self video');
    if (selfTileVideo) selfTileVideo.srcObject = localStream;
    if (mainSocketId === 'self') mainVideo.srcObject = localStream;
    isSharingScreen = false;
    shareScreenBtn.classList.remove('sharing');
    shareScreenBtn.querySelector('span').textContent = 'Share';
    toast('Screen sharing stopped');
  }

}); // end waitForIO

// ════════════════════════════════════════════════════════════
//  GLOBAL UI HELPERS
// ════════════════════════════════════════════════════════════

function showSelfInMain() {
  mainVideo.srcObject = localStream;
  mainVideo.classList.remove('remote');
  mainLabel.textContent = myName + ' (You)';
  mainSocketId = 'self';
  updateMainAvatarOverlay('self');
}

function addSelfTile() {
  const existing = document.getElementById('tile-self');
  if (existing) existing.remove();
  const tile = buildTile('self', localStream, myName + ' (You)', true);
  strip.prepend(tile);
}

function buildTile(id, stream, label, isSelf) {
  const tile = document.createElement('div');
  tile.className = 'participant-tile' + (isSelf ? ' is-self' : '');
  tile.id = `tile-${id}`;

  const avatarOverlay = document.createElement('div');
  avatarOverlay.className = 'tile-avatar';
  const ac = document.createElement('div');
  ac.className = 'avatar-circle';
  ac.textContent = initials(label);
  avatarOverlay.appendChild(ac);

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;

  const lbl = document.createElement('div');
  lbl.className = 'tile-label';
  lbl.textContent = label;

  const mutedIcon = document.createElement('div');
  mutedIcon.className = 'tile-muted-icon hidden';
  mutedIcon.id = `muted-icon-tile-${id}`;
  mutedIcon.innerHTML = micOffSVG(14);

  tile.appendChild(avatarOverlay);
  tile.appendChild(video);
  tile.appendChild(lbl);
  tile.appendChild(mutedIcon);

  tile.addEventListener('click', () => focusTile(id, stream, label, isSelf));

  // Hide avatar the moment the video actually starts rendering
  const showVideo = () => { avatarOverlay.style.display = 'none'; };
  video.addEventListener('loadedmetadata', showVideo);
  video.addEventListener('playing', showVideo);

  // Also react to tracks being added/removed on the stream
  const checkVideo = () => {
    if (!stream) return;
    const hasVideo = stream.getVideoTracks().some(t => t.readyState !== 'ended');
    if (hasVideo) {
      // Re-assign so the video element picks up any newly added track
      video.srcObject = null;
      video.srcObject = stream;
    }
    avatarOverlay.style.display = hasVideo ? 'none' : 'flex';
  };
  if (stream) {
    stream.addEventListener('addtrack', e => {
      if (e.track.kind === 'video') checkVideo();
    });
    stream.addEventListener('removetrack', checkVideo);
    checkVideo();
  }
  return tile;
}

function focusTile(id, stream, label) {
  mainSocketId = id;
  if (id === 'self') {
    mainVideo.srcObject = localStream;
    mainVideo.classList.remove('remote');
  } else {
    mainVideo.srcObject = stream;
    mainVideo.classList.add('remote');
  }
  mainLabel.textContent = label;
  updateMainAvatarOverlay(id);
}

function updateMainAvatarOverlay(id) {
  const old = mainWrapper.querySelector('.avatar-overlay');
  if (old) old.remove();
  const stream = id === 'self' ? localStream : mainVideo.srcObject;
  const label = id === 'self' ? myName : (peerNames[id] || 'Participant');
  if (!stream) return;
  const hasVideo = stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');
  if (!hasVideo) {
    const overlay = document.createElement('div');
    overlay.className = 'avatar-overlay';
    overlay.innerHTML = `<div class="avatar-circle">${initials(label)}</div><span class="avatar-name">${label}</span>`;
    mainWrapper.appendChild(overlay);
  }
}

function updateMainMutedStatus(muted) {
  mainStatus.innerHTML = '';
  if (muted) {
    const s = document.createElement('div');
    s.className = 'status-icon';
    s.innerHTML = micOffSVG(16);
    mainStatus.appendChild(s);
  }
}

function updateTileMutedIcon(id, muted) {
  const icon = document.getElementById(`muted-icon-tile-${id}`);
  if (icon) icon.classList.toggle('hidden', !muted);
}

function updateParticipantCount() {
  const count = 1 + Object.keys(peers).length;
  participantCount.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
}

function toggleChat(open) {
  chatOpen = open;
  chatPanel.classList.toggle('hidden', !open);
  if (open) {
    unreadCount = 0;
    chatBadge.classList.add('hidden');
    chatInput.focus();
  }
}

function appendMessage(name, text, timestamp, isSelf) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg' + (isSelf ? ' is-self' : '');
  const t = new Date(timestamp);
  const timeStr = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  wrap.innerHTML = `
    <div class="chat-msg-meta">
      <span class="chat-msg-name${isSelf ? ' is-self' : ''}">${esc(name)}</span>
      <span class="chat-msg-time">${timeStr}</span>
    </div>
    <div class="chat-msg-body">${esc(text)}</div>`;
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function startTimer() {
  const start = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

function initials(name) {
  return (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toast(msg, duration = 3000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

function micOffSVG(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
    <line x1="1" y1="1" x2="23" y2="23"/>
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
    <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
  </svg>`;
}

window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  if (params.get('room')) roomInput.value = params.get('room');
  nameInput.focus();
});

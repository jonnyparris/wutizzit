class GameClient {
    constructor() {
        this.socket = null;
        this.playerId = null;
        this.roomId = null;
        this.isDrawer = false;
        this.isDrawing = false;
        this.canvas = null;
        this.ctx = null;
        
        this.init();
    }

    init() {
        this.setupElements();
        this.setupEventListeners();
        this.setupCanvas();
    }

    setupElements() {
        // Home screen elements
        this.homeScreen = document.getElementById('home-screen');
        this.gameScreen = document.getElementById('game-screen');
        this.usernameInput = document.getElementById('username-input');
        this.roomInput = document.getElementById('room-input');
        this.createRoomBtn = document.getElementById('create-room-btn');
        this.joinRoomBtn = document.getElementById('join-room-btn');

        // Game screen elements
        this.roomIdDisplay = document.getElementById('room-id-display');
        this.gameStatus = document.getElementById('game-status');
        this.timer = document.getElementById('timer');
        this.roundInfo = document.getElementById('round-info');
        this.wordDisplay = document.getElementById('word-display');
        this.currentWord = document.getElementById('current-word');
        this.drawingTools = document.getElementById('drawing-tools');
        this.playersListContainer = document.getElementById('players-list');
        this.chatMessages = document.getElementById('chat-messages');
        this.chatInput = document.getElementById('chat-input');
        this.sendChatBtn = document.getElementById('send-chat');
        this.leaveRoomBtn = document.getElementById('leave-room-btn');

        // Drawing tools
        this.colorPicker = document.getElementById('color-picker');
        this.brushSize = document.getElementById('brush-size');
        this.clearCanvasBtn = document.getElementById('clear-canvas');

        // Canvas
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
    }

    setupEventListeners() {
        // Home screen
        this.createRoomBtn.addEventListener('click', () => this.createRoom());
        this.joinRoomBtn.addEventListener('click', () => this.joinRoom());
        this.usernameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                if (this.roomInput.value.trim()) {
                    this.joinRoom();
                } else {
                    this.createRoom();
                }
            }
        });
        this.roomInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.joinRoom();
        });

        // Game screen
        this.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });
        this.sendChatBtn.addEventListener('click', () => this.sendMessage());
        this.leaveRoomBtn.addEventListener('click', () => this.leaveRoom());
        this.clearCanvasBtn.addEventListener('click', () => this.clearCanvas());
    }

    setupCanvas() {
        let lastX = 0;
        let lastY = 0;

        const getMousePos = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const scaleX = this.canvas.width / rect.width;
            const scaleY = this.canvas.height / rect.height;
            
            return {
                x: (e.clientX - rect.left) * scaleX,
                y: (e.clientY - rect.top) * scaleY
            };
        };

        const getTouchPos = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const scaleX = this.canvas.width / rect.width;
            const scaleY = this.canvas.height / rect.height;
            const touch = e.touches[0];
            
            return {
                x: (touch.clientX - rect.left) * scaleX,
                y: (touch.clientY - rect.top) * scaleY
            };
        };

        // Mouse events
        this.canvas.addEventListener('mousedown', (e) => {
            if (!this.isDrawer) return;
            this.isDrawing = true;
            const pos = getMousePos(e);
            lastX = pos.x;
            lastY = pos.y;
        });

        this.canvas.addEventListener('mousemove', (e) => {
            if (!this.isDrawer || !this.isDrawing) return;
            const pos = getMousePos(e);
            this.drawStroke(lastX, lastY, pos.x, pos.y, false);
            lastX = pos.x;
            lastY = pos.y;
        });

        this.canvas.addEventListener('mouseup', () => {
            this.isDrawing = false;
        });

        // Touch events
        this.canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (!this.isDrawer) return;
            this.isDrawing = true;
            const pos = getTouchPos(e);
            lastX = pos.x;
            lastY = pos.y;
        });

        this.canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (!this.isDrawer || !this.isDrawing) return;
            const pos = getTouchPos(e);
            this.drawStroke(lastX, lastY, pos.x, pos.y, false);
            lastX = pos.x;
            lastY = pos.y;
        });

        this.canvas.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.isDrawing = false;
        });
    }

    async createRoom() {
        const username = this.usernameInput.value.trim();
        if (!username) {
            alert('Please enter a username');
            return;
        }

        try {
            const response = await fetch('/rooms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            const data = await response.json();
            if (response.ok) {
                this.roomId = data.roomId;
                await this.joinExistingRoom(username, this.roomId);
            } else {
                alert(data.error || 'Failed to create room');
            }
        } catch (error) {
            console.error('Error creating room:', error);
            alert('Failed to create room');
        }
    }

    async joinRoom() {
        const username = this.usernameInput.value.trim();
        const roomId = this.roomInput.value.trim().toUpperCase();
        
        if (!username) {
            alert('Please enter a username');
            return;
        }

        if (!roomId) {
            alert('Please enter a room ID');
            return;
        }

        await this.joinExistingRoom(username, roomId);
    }

    async joinExistingRoom(username, roomId) {
        try {
            const response = await fetch(`/rooms/${roomId}/join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });

            const data = await response.json();
            if (response.ok) {
                this.playerId = data.playerId;
                this.roomId = roomId;
                this.roomIdDisplay.textContent = roomId;
                
                this.showGameScreen();
                this.connectWebSocket(data.websocketUrl || `/rooms/${roomId}/ws?playerId=${this.playerId}`);
            } else {
                alert(data.error || 'Failed to join room');
            }
        } catch (error) {
            console.error('Error joining room:', error);
            alert('Failed to join room');
        }
    }

    connectWebSocket(url) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}${url}`;
        
        this.socket = new WebSocket(wsUrl);
        
        this.socket.onopen = () => {
            console.log('WebSocket connected');
        };
        
        this.socket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
        };
        
        this.socket.onclose = () => {
            console.log('WebSocket disconnected');
            this.showHomeScreen();
        };
        
        this.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }

    handleMessage(message) {
        switch (message.type) {
            case 'game-state':
                this.updateGameState(message.data);
                break;
            case 'join':
                this.handlePlayerJoin(message.data);
                break;
            case 'leave':
                this.handlePlayerLeave(message.data);
                break;
            case 'draw':
                this.handleDraw(message.data);
                break;
            case 'guess':
                this.handleGuess(message.data);
                break;
            case 'round-start':
                this.handleRoundStart(message.data);
                break;
            case 'drawer-word':
                this.handleDrawerWord(message.data);
                break;
            case 'timer-update':
                this.handleTimerUpdate(message.data);
                break;
            case 'round-end':
                this.handleRoundEnd(message.data);
                break;
        }
    }

    updateGameState(gameState) {
        this.updatePlayersList(gameState.players);
        if (gameState.currentRound) {
            this.updateRound(gameState.currentRound);
        }
        if (gameState.chatMessages) {
            this.updateChat(gameState.chatMessages);
        }
    }

    updatePlayersList(players) {
        this.playersListContainer.innerHTML = '';
        Object.values(players).forEach(player => {
            const playerDiv = document.createElement('div');
            playerDiv.className = `flex justify-between items-center p-2 rounded ${
                player.id === this.playerId ? 'bg-blue-100' : 'bg-gray-50'
            }`;
            playerDiv.innerHTML = `
                <span class="font-medium">${player.username}</span>
                <span class="text-sm font-bold">${player.score}</span>
            `;
            this.playersListContainer.appendChild(playerDiv);
        });
    }

    updateRound(round) {
        if (round) {
            this.roundInfo.textContent = `Round ${round.roundNumber}`;
            this.updateTimer(round.timeLeft);
        }
    }

    updateTimer(timeLeft) {
        const minutes = Math.floor(timeLeft / 60000);
        const seconds = Math.floor((timeLeft % 60000) / 1000);
        this.timer.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    updateChat(messages) {
        this.chatMessages.innerHTML = '';
        messages.forEach(message => {
            this.addChatMessage(message);
        });
    }

    handlePlayerJoin(data) {
        // Player list will be updated via game state
        this.addChatMessage({
            username: 'System',
            message: `${data.player.username} joined the room`,
            timestamp: Date.now(),
            isGuess: false
        });
    }

    handlePlayerLeave(data) {
        this.addChatMessage({
            username: 'System',
            message: `Player left the room`,
            timestamp: Date.now(),
            isGuess: false
        });
    }

    handleDraw(strokeData) {
        if (strokeData.clear) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        } else {
            this.drawStrokeOnCanvas(strokeData);
        }
    }

    handleGuess(message) {
        this.addChatMessage(message);
    }

    handleRoundStart(data) {
        this.clearCanvas();
        this.isDrawer = data.drawerId === this.playerId;
        this.roundInfo.textContent = `Round ${data.roundNumber}`;
        this.updateTimer(data.timeLeft);
        
        // Update UI based on role
        if (this.isDrawer) {
            this.drawingTools.classList.remove('hidden');
            this.gameStatus.textContent = 'You are drawing! Wait for your word...';
            this.canvas.classList.remove('disabled-canvas');
            this.chatInput.disabled = true;
            this.chatInput.placeholder = 'You cannot guess while drawing';
        } else {
            this.drawingTools.classList.add('hidden');
            this.wordDisplay.classList.add('hidden');
            this.gameStatus.textContent = 'Guess the drawing!';
            this.canvas.classList.add('disabled-canvas');
            this.chatInput.disabled = false;
            this.chatInput.placeholder = 'Type your guess...';
        }
        
        this.addChatMessage({
            username: 'System',
            message: `New round started! Round ${data.roundNumber}`,
            timestamp: Date.now(),
            isGuess: false
        });
    }

    handleDrawerWord(data) {
        if (this.isDrawer) {
            this.wordDisplay.classList.remove('hidden');
            this.currentWord.textContent = data.word;
            this.gameStatus.textContent = 'You are drawing!';
        }
    }

    handleTimerUpdate(data) {
        this.updateTimer(data.timeLeft);
    }

    handleRoundEnd(data) {
        this.addChatMessage({
            username: 'System',
            message: `Round ended! The word was: ${data.word}`,
            timestamp: Date.now(),
            isGuess: false
        });
    }

    drawStroke(x1, y1, x2, y2, isNewStroke) {
        const strokeData = {
            prevX: x1,
            prevY: y1,
            x: x2,
            y: y2,
            color: this.colorPicker.value,
            width: parseInt(this.brushSize.value),
            isNewStroke
        };

        this.drawStrokeOnCanvas(strokeData);
        
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'draw',
                data: strokeData,
                timestamp: Date.now()
            }));
        }
    }

    drawStrokeOnCanvas(strokeData) {
        this.ctx.strokeStyle = strokeData.color;
        this.ctx.lineWidth = strokeData.width;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        this.ctx.beginPath();
        if (strokeData.prevX !== undefined && strokeData.prevY !== undefined) {
            this.ctx.moveTo(strokeData.prevX, strokeData.prevY);
            this.ctx.lineTo(strokeData.x, strokeData.y);
        } else {
            this.ctx.arc(strokeData.x, strokeData.y, strokeData.width / 2, 0, Math.PI * 2);
        }
        this.ctx.stroke();
    }

    sendMessage() {
        const message = this.chatInput.value.trim();
        if (!message || this.isDrawer) return;

        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'guess',
                data: message,
                timestamp: Date.now()
            }));
        }

        this.chatInput.value = '';
    }

    addChatMessage(message) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `text-sm ${
            message.isCorrect ? 'text-green-600 font-bold' : 
            message.username === 'System' ? 'text-gray-500 italic' : 'text-gray-800'
        }`;
        
        const time = new Date(message.timestamp).toLocaleTimeString('en-US', { 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        
        messageDiv.innerHTML = `
            <span class="text-gray-400 text-xs">[${time}]</span>
            <span class="font-medium">${message.username}:</span>
            ${message.isCorrect ? '✓ ' : ''}${message.message}
        `;
        
        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    clearCanvas() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Only send clear command if we're the drawer
        if (this.isDrawer && this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'draw',
                data: { clear: true },
                timestamp: Date.now()
            }));
        }
    }

    async leaveRoom() {
        if (this.socket) {
            this.socket.close();
        }

        if (this.roomId && this.playerId) {
            try {
                await fetch(`/rooms/${this.roomId}/leave`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ playerId: this.playerId })
                });
            } catch (error) {
                console.error('Error leaving room:', error);
            }
        }

        this.showHomeScreen();
    }

    showGameScreen() {
        this.homeScreen.classList.add('hidden');
        this.gameScreen.classList.remove('hidden');
    }

    showHomeScreen() {
        this.gameScreen.classList.add('hidden');
        this.homeScreen.classList.remove('hidden');
        this.roomInput.value = '';
        this.playerId = null;
        this.roomId = null;
        this.isDrawer = false;
    }
}

// Initialize the game when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new GameClient();
});
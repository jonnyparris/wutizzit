class GameClient {
    constructor() {
        this.socket = null;
        this.playerId = null;
        this.roomId = null;
        this.isDrawer = false;
        this.isDrawing = false;
        this.canvas = null;
        this.ctx = null;
        this.audioContext = null;
        this.isRoomCreator = false;
        this.currentDrawerId = null;
        
        this.init();
    }

    init() {
        this.setupElements();
        this.setupEventListeners();
        this.setupCanvas();
        this.generateRandomUsername();
        this.updateHomePageStats();
        this.initAudio();
        this.startStatsRefreshTimer();
        this.handleUrlRouting();
        
        // Handle browser back/forward navigation
        window.addEventListener('popstate', (event) => {
            this.handleUrlRouting();
        });
    }
    
    handleUrlRouting() {
        const path = window.location.pathname;
        const roomMatch = path.match(/^\/room\/([A-Z0-9]{6})$/i);
        
        if (roomMatch) {
            const roomId = roomMatch[1].toUpperCase();
            // Auto-join the room if we have a username and aren't already in a game
            if (this.usernameInput.value && !this.roomId) {
                this.roomInput.value = roomId;
                this.joinRoom(roomId);
            } else if (!this.usernameInput.value) {
                // Show room ID in input but don't auto-join until username is provided
                this.roomInput.value = roomId;
            }
        }
    }
    
    updateUrl(roomId) {
        const newUrl = roomId ? `/room/${roomId}` : '/';
        if (window.location.pathname !== newUrl) {
            window.history.pushState({ roomId }, '', newUrl);
        }
    }
    
    async copyRoomLink() {
        if (!this.roomId) return;
        
        const roomUrl = `${window.location.origin}/room/${this.roomId}`;
        
        try {
            await navigator.clipboard.writeText(roomUrl);
            // Briefly change button text to show success
            const originalText = this.copyRoomLinkBtn.innerHTML;
            this.copyRoomLinkBtn.innerHTML = '✅ Copied!';
            this.copyRoomLinkBtn.disabled = true;
            
            setTimeout(() => {
                this.copyRoomLinkBtn.innerHTML = originalText;
                this.copyRoomLinkBtn.disabled = false;
            }, 2000);
        } catch (error) {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = roomUrl;
            document.body.appendChild(textArea);
            textArea.select();
            try {
                document.execCommand('copy');
                this.copyRoomLinkBtn.innerHTML = '✅ Copied!';
                setTimeout(() => {
                    this.copyRoomLinkBtn.innerHTML = '📋 Share Link';
                }, 2000);
            } catch (fallbackError) {
                alert(`Copy failed. Room URL: ${roomUrl}`);
            }
            document.body.removeChild(textArea);
        }
    }

    initAudio() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (error) {
            console.warn('Audio not supported:', error);
        }
    }

    playSound(frequency, duration = 200, type = 'sine') {
        if (!this.audioContext) return;
        
        try {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
            oscillator.type = type;
            
            gainNode.gain.setValueAtTime(0.1, this.audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration / 1000);
            
            oscillator.start(this.audioContext.currentTime);
            oscillator.stop(this.audioContext.currentTime + duration / 1000);
        } catch (error) {
            console.warn('Failed to play sound:', error);
        }
    }

    playSoundEffect(effect) {
        switch (effect) {
            case 'correct-guess':
                this.playSound(523, 300); // C5 note
                setTimeout(() => this.playSound(659, 300), 100); // E5 note
                setTimeout(() => this.playSound(784, 400), 200); // G5 note
                break;
            case 'wrong-guess':
                this.playSound(200, 150); // Low buzz
                break;
            case 'round-end':
                this.playSound(330, 200); // E4
                setTimeout(() => this.playSound(262, 400), 300); // C4
                break;
            case 'game-start':
                this.playSound(392, 150); // G4
                setTimeout(() => this.playSound(523, 150), 200); // C5
                setTimeout(() => this.playSound(659, 300), 400); // E5
                break;
            case 'player-join':
                this.playSound(440, 150); // A4
                break;
            case 'timer-warning':
                this.playSound(800, 100); // High beep
                break;
            case 'timer-tick':
                this.playSound(600, 80); // Short tick
                break;
        }
    }

    async updateHomePageStats() {
        try {
            const [statsResponse, gamesResponse] = await Promise.all([
                fetch('/api/stats'),
                fetch('/api/active-games')
            ]);
            
            const stats = await statsResponse.json();
            const activeGamesData = await gamesResponse.json();
            
            document.getElementById('active-games').textContent = stats.activeGames || 0;
            document.getElementById('total-players').textContent = stats.totalPlayers || 0;
            
            // Show real active games
            const gamesContainer = document.getElementById('games-container');
            const activeGamesList = document.getElementById('active-games-list');
            
            if (activeGamesData.games && activeGamesData.games.length > 0) {
                gamesContainer.innerHTML = '';
                activeGamesData.games.forEach(game => {
                    const gameDiv = document.createElement('div');
                    gameDiv.className = 'p-2 bg-white rounded border cursor-pointer hover:bg-gray-50';
                    
                    const statusText = game.gameStarted 
                        ? `${game.playerCount} players • In game`
                        : `${game.playerCount} players • Waiting to start`;
                    
                    gameDiv.innerHTML = `
                        <div class="flex justify-between items-center">
                            <div>
                                <div class="font-medium text-sm">${game.id}</div>
                                <div class="text-xs text-gray-500">${statusText}</div>
                            </div>
                            <button class="px-2 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600">
                                Join
                            </button>
                        </div>
                    `;
                    gameDiv.onclick = () => {
                        this.roomInput.value = game.id;
                        this.joinRoom(game.id);
                    };
                    gamesContainer.appendChild(gameDiv);
                });
                activeGamesList.classList.remove('hidden');
            } else {
                activeGamesList.classList.add('hidden');
            }
        } catch (error) {
            console.error('Failed to fetch stats:', error);
            // Fallback to static numbers
            document.getElementById('active-games').textContent = '0';
            document.getElementById('total-players').textContent = '0';
        }
    }

    startStatsRefreshTimer() {
        // Clear existing timer if it exists
        if (this.statsRefreshInterval) {
            clearInterval(this.statsRefreshInterval);
        }
        
        // Update stats every 5 seconds when on homepage
        this.statsRefreshInterval = setInterval(() => {
            // Only refresh if we're on the homepage
            if (!this.homeScreen.classList.contains('hidden')) {
                this.updateHomePageStats();
            }
        }, 5000);
    }

    stopStatsRefreshTimer() {
        if (this.statsRefreshInterval) {
            clearInterval(this.statsRefreshInterval);
            this.statsRefreshInterval = null;
        }
    }

    generateRandomUsername() {
        const adjectives = [
            'Sneaky', 'Mighty', 'Swift', 'Brave', 'Clever', 'Cosmic', 'Magic', 'Royal',
            'Silent', 'Golden', 'Silver', 'Wild', 'Dancing', 'Singing', 'Flying', 'Wise',
            'Ancient', 'Mysterious', 'Legendary', 'Epic', 'Daring', 'Fearless', 'Noble'
        ];
        
        const celebrities = [
            // Historical Figures
            'Einstein', 'Cleopatra', 'Napoleon', 'Shakespeare', 'DaVinci', 'Mozart', 'Beethoven',
            // Fictional Characters
            'Gandalf', 'Yoda', 'Batman', 'Superman', 'Hermione', 'Dumbledore', 'Sherlock',
            'Aragorn', 'Legolas', 'Frodo', 'Spiderman', 'Ironman', 'Thor', 'Hulk',
            'Pikachu', 'Mario', 'Luigi', 'Zelda', 'Link', 'Sonic', 'Kirby',
            'Elsa', 'Anna', 'Simba', 'Nemo', 'Woody', 'Buzz', 'Shrek', 'Donkey',
            'Mickey', 'Minnie', 'Donald', 'Goofy', 'Scrooge', 'Winnie', 'Tigger',
            'Garfield', 'Snoopy', 'Charlie', 'Homer', 'Bart', 'Lisa', 'Marge',
            // Mythological
            'Zeus', 'Athena', 'Apollo', 'Artemis', 'Hercules', 'Perseus', 'Achilles',
            'Odin', 'Thor', 'Loki', 'Freya', 'Merlin', 'Arthur', 'Excalibur'
        ];
        
        const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
        const celebrity = celebrities[Math.floor(Math.random() * celebrities.length)];
        
        this.usernameInput.placeholder = `e.g. ${adjective}${celebrity}`;
        this.usernameInput.value = `${adjective}${celebrity}`;
    }

    generatePlayerAvatar(playerId) {
        const avatars = [
            '🐱', '🐶', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', 
            '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆',
            '🦋', '🐛', '🐝', '🐞', '🦄', '🐲', '👽', '🤖', '🎭', '🎪'
        ];
        
        // Use playerId as seed for consistent avatar per player
        let hash = 0;
        for (let i = 0; i < playerId.length; i++) {
            const char = playerId.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        
        return avatars[Math.abs(hash) % avatars.length];
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
        this.wordHint = document.getElementById('word-hint');
        this.hintText = document.getElementById('hint-text');
        this.letterCount = document.getElementById('letter-count');
        this.wordChoice = document.getElementById('word-choice');
        this.choiceTimer = document.getElementById('choice-timer');
        this.drawingTools = document.getElementById('drawing-tools');
        this.playersListContainer = document.getElementById('players-list');
        this.chatMessages = document.getElementById('chat-messages');
        this.chatInput = document.getElementById('chat-input');
        this.sendChatBtn = document.getElementById('send-chat');
        this.leaveRoomBtn = document.getElementById('leave-room-btn');
        this.startGameBtn = document.getElementById('start-game-btn');

        // Drawing tools
        this.colorPicker = document.getElementById('color-picker');
        this.brushSize = document.getElementById('brush-size');
        this.clearCanvasBtn = document.getElementById('clear-canvas');
        this.undoCanvasBtn = document.getElementById('undo-canvas');
        this.fillToolBtn = document.getElementById('fill-tool');

        // Canvas
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');

        // Game settings (for room creator)
        this.gameSettings = document.getElementById('game-settings');
        this.roundsSetting = document.getElementById('rounds-setting');
        this.durationSetting = document.getElementById('duration-setting');
        this.wordChoicesSetting = document.getElementById('word-choices-setting');
        this.wordListBtn = document.getElementById('word-list-btn');
        this.wordListModal = document.getElementById('word-list-modal');
        this.customWordsTextarea = document.getElementById('custom-words');
        this.saveWordsBtn = document.getElementById('save-words-btn');
        this.cancelWordsBtn = document.getElementById('cancel-words-btn');

        // Winner modal elements
        this.winnerModal = document.getElementById('winner-modal');
        this.celebrationGif = document.getElementById('celebration-gif');
        this.firstPlacePlayer = document.getElementById('first-place-player');
        this.firstPlaceScore = document.getElementById('first-place-score');
        this.secondPlacePlayer = document.getElementById('second-place-player');
        this.secondPlaceScore = document.getElementById('second-place-score');
        this.thirdPlacePlayer = document.getElementById('third-place-player');
        this.thirdPlaceScore = document.getElementById('third-place-score');
        this.closeWinnerModalBtn = document.getElementById('close-winner-modal');
        this.pauseGameBtn = document.getElementById('pause-game-btn');
        this.copyRoomLinkBtn = document.getElementById('copy-room-link');
        
        // Canvas state stack for undo functionality
        this.canvasStates = [];
        this.maxUndoStates = 20;
        
        // Fill tool state
        this.fillMode = false;
        
        // Game settings
        this.maxRounds = 10; // Default, will be updated by server
        this.statsRefreshInterval = null; // Timer for refreshing homepage stats
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
        this.undoCanvasBtn.addEventListener('click', () => this.undoCanvas());
        this.fillToolBtn.addEventListener('click', () => this.toggleFillTool());
        this.startGameBtn.addEventListener('click', () => this.startGame());
        
        // Game settings event listeners
        this.wordListBtn.addEventListener('click', () => this.openWordListModal());
        this.saveWordsBtn.addEventListener('click', () => this.saveCustomWords());
        this.cancelWordsBtn.addEventListener('click', () => this.closeWordListModal());
        this.pauseGameBtn.addEventListener('click', () => this.togglePauseGame());
        this.copyRoomLinkBtn.addEventListener('click', () => this.copyRoomLink());
        
        // Winner modal event listener
        this.closeWinnerModalBtn.addEventListener('click', () => this.closeWinnerModal());
        
        // Color picker event listeners
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('color-swatch')) {
                this.selectColor(e.target.dataset.color);
            }
            if (e.target.classList.contains('ban-player-btn')) {
                this.banPlayer(e.target.dataset.playerId);
            }
        });
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
            
            const pos = getMousePos(e);
            
            if (this.fillMode) {
                this.saveCanvasState(); // Save state before fill
                this.floodFill(Math.floor(pos.x), Math.floor(pos.y));
                return;
            }
            
            this.saveCanvasState(); // Save state before drawing
            this.isDrawing = true;
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
            
            const pos = getTouchPos(e);
            
            if (this.fillMode) {
                this.saveCanvasState(); // Save state before fill
                this.floodFill(Math.floor(pos.x), Math.floor(pos.y));
                return;
            }
            
            this.saveCanvasState(); // Save state before drawing
            this.isDrawing = true;
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
                this.isCreator = data.isCreator;
                this.roomIdDisplay.textContent = roomId;
                
                // Update URL to reflect the room
                this.updateUrl(roomId);
                
                this.showGameScreen();
                this.connectWebSocket(data.websocketUrl || `/rooms/${roomId}/ws?playerId=${this.playerId}`);
                
                // Show start button and settings for room creator
                if (data.isCreator && !data.gameStarted) {
                    this.startGameBtn.classList.remove('hidden');
                    this.gameSettings.classList.remove('hidden');
                    this.gameStatus.textContent = '⏳ Waiting for more players. You can start the game when ready.';
                }
                
                // Load lobby background image if game hasn't started
                if (!data.gameStarted) {
                    this.loadLobbyBackgroundImage();
                }
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
            this.gameStatus.textContent = '🔗 Connected! Waiting for game to start...';
        };
        
        this.socket.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleMessage(message);
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        };
        
        this.socket.onclose = (event) => {
            console.log('WebSocket disconnected', event.code, event.reason);
            if (!event.wasClean) {
                this.gameStatus.textContent = '⚠️ Connection lost. Attempting to reconnect...';
                // Attempt to reconnect after a delay
                setTimeout(() => {
                    if (this.roomId && this.playerId) {
                        this.connectWebSocket(url);
                    }
                }, 2000);
            } else {
                this.showHomeScreen();
            }
        };
        
        this.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.gameStatus.textContent = '❌ Connection error. Please try refreshing.';
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
            case 'word-choice':
                this.handleWordChoice(message.data);
                break;
            case 'round-prepare':
                this.handleRoundPrepare(message.data);
                break;
            case 'game-end':
                this.handleGameEnd(message.data);
                break;
            case 'player-banned':
                this.handlePlayerBanned(message.data);
                break;
            case 'game-pause':
                this.handleGamePause(message.data);
                break;
        }
    }

    updateGameState(gameState) {
        // Store players data for score updates
        this.playersData = gameState.players;
        this.updatePlayersList(gameState.players);
        
        // Update round info even when no active round
        if (gameState.maxRounds) {
            this.maxRounds = gameState.maxRounds;
        }
        
        if (gameState.currentRound) {
            this.updateRound(gameState.currentRound);
        } else if (gameState.gameStarted && gameState.currentRoundNumber !== undefined) {
            // Show current round info even between rounds
            this.roundInfo.textContent = `Round ${gameState.currentRoundNumber} of ${this.maxRounds}`;
        } else {
            // Before game starts
            this.roundInfo.textContent = `Round 0 of ${this.maxRounds}`;
            // Load lobby background if game hasn't started
            if (!gameState.gameStarted) {
                this.loadLobbyBackgroundImage();
            }
        }
        
        if (gameState.chatMessages) {
            this.updateChat(gameState.chatMessages);
        }
    }

    updatePlayersList(players) {
        if (!players) return;
        
        // Find the highest score for crown emoji
        const playerArray = Object.values(players);
        const maxScore = Math.max(...playerArray.map(p => p.score));
        
        this.playersListContainer.innerHTML = '';
        playerArray
            .sort((a, b) => b.score - a.score) // Sort by score descending
            .forEach(player => {
                const isLeader = player.score === maxScore && maxScore > 0;
                const isCurrentPlayer = player.id === this.playerId;
                const isCurrentDrawer = player.id === this.currentDrawerId;
                const playerDiv = document.createElement('div');
                
                // Determine styling based on player state
                let className = 'flex justify-between items-center p-3 player-card ';
                if (isCurrentDrawer) {
                    className += 'ring-2 ring-green-400 bg-green-50 border-2 border-green-300';
                } else if (isCurrentPlayer) {
                    className += 'ring-2 ring-blue-400 bg-blue-50 border-2 border-blue-300';
                }
                playerDiv.className = className;
                
                const avatar = this.generatePlayerAvatar(player.id);
                
                // Show ban button for room creator (but not for themselves)
                const canBan = this.isCreator && !isCurrentPlayer;
                
                playerDiv.innerHTML = `
                    <div class="flex items-center gap-2">
                        <span class="text-lg">${avatar}</span>
                        <span class="font-medium ${isCurrentPlayer ? 'text-blue-700 font-bold' : isCurrentDrawer ? 'text-green-700 font-bold' : ''}">
                            ${isCurrentPlayer ? '👤 ' : ''}${isCurrentDrawer ? '🎨 ' : ''}${isLeader ? '👑 ' : ''}${player.username}${isCurrentPlayer ? ' (You)' : ''}${isCurrentDrawer ? ' (Drawing)' : ''}
                        </span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-bold ${isCurrentPlayer ? 'text-blue-700' : isCurrentDrawer ? 'text-green-700' : ''}">${player.score}</span>
                        ${canBan ? `<button class="ban-player-btn text-xs px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600" data-player-id="${player.id}">🚫</button>` : ''}
                    </div>
                `;
                this.playersListContainer.appendChild(playerDiv);
            });
            
        // Update round options based on player count (for fair turns)
        this.updateRoundOptions(playerArray.length);
    }
    
    updateRoundOptions(playerCount) {
        // Only update if we're the room creator and game hasn't started
        if (!this.isCreator || !this.roundsSetting) return;
        
        // Store current value
        const currentValue = parseInt(this.roundsSetting.value);
        
        // Clear existing options
        this.roundsSetting.innerHTML = '';
        
        // Generate round options that are multiples of player count
        // This ensures everyone gets an equal number of turns to draw
        const minRounds = Math.max(playerCount, 2); // At least 2 rounds minimum
        const maxRounds = playerCount * 5; // Up to 5 turns per player
        
        const options = [];
        for (let multiplier = 1; multiplier <= 5; multiplier++) {
            const rounds = playerCount * multiplier;
            if (rounds >= minRounds && rounds <= 30) { // Cap at 30 rounds max
                options.push(rounds);
            }
        }
        
        // Add options to dropdown
        let selectedValue = options[1] || options[0]; // Default to 2x player count, or first available
        
        options.forEach(rounds => {
            const option = document.createElement('option');
            option.value = rounds;
            option.textContent = `${rounds} (${Math.floor(rounds/playerCount)} per player)`;
            
            // Try to maintain the current selection if it's still valid
            if (rounds === currentValue) {
                selectedValue = rounds;
            }
            
            this.roundsSetting.appendChild(option);
        });
        
        // Set the selected value
        this.roundsSetting.value = selectedValue;
    }

    updateRound(round) {
        if (round) {
            this.roundInfo.textContent = `Round ${round.roundNumber} of ${this.maxRounds}`;
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
        // Update players data and refresh list
        if (this.playersData) {
            this.playersData[data.player.id] = data.player;
            this.updatePlayersList(this.playersData);
        }
        
        this.addChatMessage({
            username: 'System',
            message: `👋 ${data.player.username} joined`,
            timestamp: Date.now(),
            isGuess: false
        });
        this.playSoundEffect('player-join');
    }

    handlePlayerLeave(data) {
        // Remove player from stored data and refresh list
        if (this.playersData && data.playerId) {
            delete this.playersData[data.playerId];
            this.updatePlayersList(this.playersData);
        }
        
        let leaveMessage = `🚪 Player left the room`;
        
        // Handle ownership transfer
        if (data.ownerTransferred && data.newOwnerId) {
            const newOwnerName = this.playersData?.[data.newOwnerId]?.username || 'Unknown Player';
            leaveMessage += `\n👑 ${newOwnerName} is now the room owner`;
            
            // Update UI if the current player became owner
            if (data.newOwnerId === this.playerId) {
                this.startGameBtn.classList.remove('hidden');
                this.addChatMessage({
                    username: 'System',
                    message: '👑 You are now the room owner! You can start the game.',
                    timestamp: Date.now(),
                    isGuess: false
                });
            }
        }
        
        this.addChatMessage({
            username: 'System',
            message: leaveMessage,
            timestamp: Date.now(),
            isGuess: false
        });
    }

    handleDraw(strokeData) {
        if (strokeData.clear) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            // Clear canvas states for other players too
            this.canvasStates = [];
            this.updateUndoButton();
        } else if (strokeData.undo) {
            // Handle undo from other players
            if (this.canvasStates.length > 0) {
                const previousState = this.canvasStates.pop();
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.ctx.putImageData(previousState, 0, 0);
                this.updateUndoButton();
            }
        } else if (strokeData.fill) {
            // Handle fill from other players
            if (!this.isDrawer) {
                this.saveCanvasState();
            }
            this.performFillForOtherPlayer(strokeData.x, strokeData.y, strokeData.color);
        } else {
            // Save state before applying received drawing data (for non-drawer players)
            if (!this.isDrawer) {
                this.saveCanvasState();
            }
            this.drawStrokeOnCanvas(strokeData);
        }
    }

    handleGuess(message) {
        this.addChatMessage(message);
        
        // Play sound effects for correct/wrong guesses
        if (message.isCorrect) {
            this.playSoundEffect('correct-guess');
        } else if (message.playerId === this.playerId) {
            // Only play wrong sound for own guesses to avoid spam
            this.playSoundEffect('wrong-guess');
        }
        
        // If this player guessed correctly, disable further guessing
        if (message.isCorrect && message.playerId === this.playerId) {
            this.chatInput.disabled = true;
            this.chatInput.placeholder = 'You guessed correctly! Wait for next round...';
        }
    }

    handleRoundStart(data) {
        this.clearCanvas();
        this.isDrawer = data.drawerId === this.playerId;
        this.currentDrawerId = data.drawerId;
        this.playSoundEffect('game-start');
        
        // Update max rounds if provided by server
        if (data.maxRounds) {
            this.maxRounds = data.maxRounds;
        }
        this.roundInfo.textContent = `Round ${data.roundNumber} of ${this.maxRounds}`;
        this.updateTimer(data.timeLeft);
        
        // Update UI based on role
        if (this.isDrawer) {
            this.drawingTools.classList.remove('hidden');
            this.gameStatus.textContent = '🎨 You are drawing! Wait for your word...';
            this.canvas.classList.remove('disabled-canvas');
            this.chatInput.disabled = true;
            this.chatInput.placeholder = 'You cannot guess while drawing';
            this.wordHint.classList.add('hidden');
        } else {
            this.drawingTools.classList.add('hidden');
            this.wordDisplay.classList.add('hidden');
            this.gameStatus.textContent = '🤔 Guess the drawing!';
            this.canvas.classList.add('disabled-canvas');
            this.chatInput.disabled = false;
            this.chatInput.placeholder = 'Type your guess...';
            
            // Show word hint for guessers
            if (data.wordHint) {
                this.hintText.textContent = data.wordHint;
                // Count letters by counting underscores (which represent letters)
                const letterCount = data.wordHint.replace(/[^_]/g, '').length;
                this.letterCount.textContent = `(${letterCount} letters)`;
                this.wordHint.classList.remove('hidden');
            }
        }
        
        this.addChatMessage({
            username: 'System',
            message: `🎨 Round ${data.roundNumber} started!`,
            timestamp: Date.now(),
            isGuess: false
        });
        
        // Update player list to highlight the current drawer
        if (this.playersData) {
            this.updatePlayersList(this.playersData);
        }
    }

    handleDrawerWord(data) {
        if (this.isDrawer) {
            this.wordDisplay.classList.remove('hidden');
            this.currentWord.textContent = data.word;
            this.gameStatus.textContent = '🎨 You are drawing!';
        }
    }

    handleTimerUpdate(data) {
        this.updateTimer(data.timeLeft);
        
        // Show pause indicator if game is paused
        if (data.isPaused) {
            const timerElement = this.timer;
            if (!timerElement.textContent.includes('⏸️')) {
                timerElement.textContent += ' ⏸️';
            }
        }
        
        // Play ticking sound for final 10 seconds (but not when paused)
        if (!data.isPaused) {
            const secondsLeft = Math.floor(data.timeLeft / 1000);
            if (secondsLeft <= 10 && secondsLeft > 0) {
                this.playSoundEffect('timer-tick');
            }
        }
    }


    handleRoundEnd(data) {
        const wordDisplay = data.revealed ? data.word : 'Hidden (you didn\'t guess correctly)';
        this.addChatMessage({
            username: 'System',
            message: `⏰ Round ended! Word: ${wordDisplay}`,
            timestamp: Date.now(),
            isGuess: false
        });
        this.playSoundEffect('round-end');
        
        // Clear drawer highlighting when round ends
        this.currentDrawerId = null;
        
        // Update scores with final data
        if (data.scores) {
            this.playersData = data.scores;
            this.updatePlayersList(this.playersData);
        }
        
        // Show score summary if there were any score updates
        if (data.scoreUpdates && data.scoreUpdates.length > 0) {
            this.addChatMessage({
                username: 'System',
                message: '🏆 Round Summary:',
                timestamp: Date.now(),
                isGuess: false
            });
            
            // Group updates by unique players (in case someone guessed multiple times)
            const playerUpdates = new Map();
            let drawerUpdate = null;
            
            data.scoreUpdates.forEach(update => {
                if (!playerUpdates.has(update.playerId)) {
                    playerUpdates.set(update.playerId, {
                        name: update.playerName,
                        points: update.pointsEarned
                    });
                }
                
                if (update.drawerName && !drawerUpdate) {
                    drawerUpdate = {
                        name: update.drawerName,
                        points: update.drawerPointsEarned
                    };
                }
            });
            
            // Show player score updates
            playerUpdates.forEach(update => {
                this.addChatMessage({
                    username: 'System',
                    message: `  🎉 ${update.name}: +${update.points} points`,
                    timestamp: Date.now(),
                    isGuess: false
                });
            });
            
            // Show drawer score update
            if (drawerUpdate) {
                this.addChatMessage({
                    username: 'System',
                    message: `  🎨 ${drawerUpdate.name}: +${drawerUpdate.points} points (drawing)`,
                    timestamp: Date.now(),
                    isGuess: false
                });
            }
        }
    }

    handleWordChoice(data) {
        // Clear existing word choice buttons
        const wordChoiceContainer = this.wordChoice.querySelector('.flex');
        wordChoiceContainer.innerHTML = '';
        
        // Dynamically create buttons for each word choice
        data.wordChoices.forEach((word, index) => {
            const button = document.createElement('button');
            button.id = `word-choice-${index + 1}`;
            button.className = 'px-4 py-2 fun-button rounded-lg';
            button.textContent = word;
            button.onclick = () => this.chooseWord(word);
            wordChoiceContainer.appendChild(button);
        });
        
        this.wordChoice.classList.remove('hidden');
        this.gameStatus.textContent = '📝 Choose your word to draw!';
        
        // Start choice timer
        let timeLeft = 20;
        this.choiceTimerInterval = setInterval(() => {
            timeLeft--;
            this.choiceTimer.textContent = `${timeLeft} seconds to choose`;
            if (timeLeft <= 0) {
                clearInterval(this.choiceTimerInterval);
                this.choiceTimerInterval = null;
                // Auto-choose first word if time runs out
                this.chooseWord(data.wordChoices[0]);
            }
        }, 1000);
    }

    handleRoundPrepare(data) {
        // Update max rounds if provided by server
        if (data.maxRounds) {
            this.maxRounds = data.maxRounds;
        }
        this.roundInfo.textContent = `Round ${data.roundNumber} of ${this.maxRounds}`;
        if (data.drawerId === this.playerId) {
            this.gameStatus.textContent = '🎨 You are the drawer! Waiting for word choice...';
        } else {
            this.gameStatus.textContent = '⏳ Waiting for drawer to choose word...';
        }
    }

    chooseWord(word) {
        // Clear the choice timer if it's running
        if (this.choiceTimerInterval) {
            clearInterval(this.choiceTimerInterval);
            this.choiceTimerInterval = null;
        }
        
        this.wordChoice.classList.add('hidden');
        
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'word-choice',
                data: word,
                timestamp: Date.now()
            }));
        }
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
        messageDiv.className = `chat-bubble text-sm ${
            message.isCorrect ? 'bg-green-500' : 
            message.username === 'System' ? 'bg-gray-500' : ''
        }`;
        
        const time = new Date(message.timestamp).toLocaleTimeString('en-US', { 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        
        messageDiv.innerHTML = `
            <span class="opacity-75 text-xs">[${time}]</span>
            <span class="font-medium">${message.username}:</span>
            ${message.isCorrect ? '✅ ' : ''}${message.message}
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

    async loadLobbyBackgroundImage() {
        // Use a beautiful gradient background with geometric patterns instead of external images
        // This avoids CORS issues and ensures consistent loading
        this.createLobbyBackground();
    }

    createLobbyBackground() {
        try {
            // Clear canvas first
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            
            // Create multiple gradient backgrounds to choose from
            const gradients = [
                // Purple to blue
                ['#667eea', '#764ba2'],
                // Orange to pink  
                ['#f093fb', '#f5576c'],
                // Green to teal
                ['#4facfe', '#00f2fe'],
                // Sunset colors
                ['#fa709a', '#fee140'],
                // Ocean colors
                ['#a8edea', '#fed6e3'],
                // Northern lights
                ['#d299c2', '#fef9d7'],
                // Fire colors
                ['#fdbb2d', '#22c1c3'],
                // Space colors
                ['#2196f3', '#21cbf3']
            ];
            
            const randomGradient = gradients[Math.floor(Math.random() * gradients.length)];
            
            // Create radial gradient for more visual interest
            const gradient = this.ctx.createRadialGradient(
                this.canvas.width / 2, this.canvas.height / 2, 0,
                this.canvas.width / 2, this.canvas.height / 2, Math.max(this.canvas.width, this.canvas.height) / 2
            );
            gradient.addColorStop(0, randomGradient[0]);
            gradient.addColorStop(1, randomGradient[1]);
            
            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            
            // Add some geometric shapes for visual interest
            this.addGeometricPatterns();
            
            // Add overlay and text
            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            
            this.ctx.fillStyle = 'white';
            this.ctx.font = 'bold 28px Inter, system-ui, sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
            this.ctx.shadowBlur = 4;
            this.ctx.shadowOffsetX = 2;
            this.ctx.shadowOffsetY = 2;
            
            this.ctx.fillText('Waiting for game to start...', this.canvas.width / 2, this.canvas.height / 2 - 20);
            
            this.ctx.font = '18px Inter, system-ui, sans-serif';
            this.ctx.fillText('🎨 Get ready to draw and guess!', this.canvas.width / 2, this.canvas.height / 2 + 20);
            
            // Reset shadow
            this.ctx.shadowColor = 'transparent';
            this.ctx.shadowBlur = 0;
            this.ctx.shadowOffsetX = 0;
            this.ctx.shadowOffsetY = 0;
            
        } catch (error) {
            console.warn('Failed to create lobby background:', error);
            this.showLobbyText();
        }
    }

    addGeometricPatterns() {
        const patterns = [
            () => this.drawCirclePattern(),
            () => this.drawTrianglePattern(),
            () => this.drawHexagonPattern(),
            () => this.drawWavePattern()
        ];
        
        // Randomly choose a pattern
        const randomPattern = patterns[Math.floor(Math.random() * patterns.length)];
        randomPattern();
    }

    drawCirclePattern() {
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        for (let i = 0; i < 8; i++) {
            const x = Math.random() * this.canvas.width;
            const y = Math.random() * this.canvas.height;
            const radius = 20 + Math.random() * 60;
            this.ctx.beginPath();
            this.ctx.arc(x, y, radius, 0, Math.PI * 2);
            this.ctx.fill();
        }
    }

    drawTrianglePattern() {
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        for (let i = 0; i < 6; i++) {
            const x = Math.random() * this.canvas.width;
            const y = Math.random() * this.canvas.height;
            const size = 30 + Math.random() * 50;
            
            this.ctx.beginPath();
            this.ctx.moveTo(x, y - size/2);
            this.ctx.lineTo(x - size/2, y + size/2);
            this.ctx.lineTo(x + size/2, y + size/2);
            this.ctx.closePath();
            this.ctx.fill();
        }
    }

    drawHexagonPattern() {
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        this.ctx.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
            const x = Math.random() * this.canvas.width;
            const y = Math.random() * this.canvas.height;
            const size = 25 + Math.random() * 40;
            
            this.ctx.beginPath();
            for (let j = 0; j < 6; j++) {
                const angle = (j * Math.PI) / 3;
                const px = x + size * Math.cos(angle);
                const py = y + size * Math.sin(angle);
                if (j === 0) {
                    this.ctx.moveTo(px, py);
                } else {
                    this.ctx.lineTo(px, py);
                }
            }
            this.ctx.closePath();
            this.ctx.stroke();
        }
    }

    drawWavePattern() {
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        this.ctx.lineWidth = 3;
        
        for (let i = 0; i < 3; i++) {
            const startY = (this.canvas.height / 4) * (i + 1);
            const amplitude = 20 + Math.random() * 30;
            const frequency = 0.01 + Math.random() * 0.02;
            const phase = Math.random() * Math.PI * 2;
            
            this.ctx.beginPath();
            for (let x = 0; x <= this.canvas.width; x += 5) {
                const y = startY + amplitude * Math.sin(frequency * x + phase);
                if (x === 0) {
                    this.ctx.moveTo(x, y);
                } else {
                    this.ctx.lineTo(x, y);
                }
            }
            this.ctx.stroke();
        }
    }

    showLobbyText() {
        // Fallback lobby display with gradient background
        const gradient = this.ctx.createLinearGradient(0, 0, this.canvas.width, this.canvas.height);
        gradient.addColorStop(0, '#667eea');
        gradient.addColorStop(1, '#764ba2');
        
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.fillStyle = 'white';
        this.ctx.font = 'bold 24px Inter, system-ui, sans-serif';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('Waiting for game to start...', this.canvas.width / 2, this.canvas.height / 2);
        
        this.ctx.font = '16px Inter, system-ui, sans-serif';
        this.ctx.fillText('🎨 Get ready to draw and guess!', this.canvas.width / 2, this.canvas.height / 2 + 40);
    }

    saveCanvasState() {
        const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        this.canvasStates.push(imageData);
        
        // Limit the number of saved states
        if (this.canvasStates.length > this.maxUndoStates) {
            this.canvasStates.shift();
        }
        
        this.updateUndoButton();
    }

    undoCanvas() {
        if (this.canvasStates.length === 0) return;
        
        const previousState = this.canvasStates.pop();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.putImageData(previousState, 0, 0);
        
        this.updateUndoButton();
        
        // Send undo command to other players if we're the drawer
        if (this.isDrawer && this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'draw',
                data: { undo: true },
                timestamp: Date.now()
            }));
        }
    }

    updateUndoButton() {
        this.undoCanvasBtn.disabled = this.canvasStates.length === 0;
    }

    toggleFillTool() {
        this.fillMode = !this.fillMode;
        
        // Update button appearance
        if (this.fillMode) {
            this.fillToolBtn.classList.add('bg-green-700', 'ring-2', 'ring-green-300');
            this.fillToolBtn.classList.remove('bg-green-500');
            this.canvas.style.cursor = 'url(data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMCAyMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEwIDJMMTggMTBIMTRMMTAgNlY2TDYgMTBIMkwxMCAyWiIgZmlsbD0iYmxhY2siLz4KPHBhdGggZD0iTTIgMTRIMThWMThIMlYxNFoiIGZpbGw9ImJsYWNrIi8+Cjwvc3ZnPgo=) 10 18, auto';
        } else {
            this.fillToolBtn.classList.remove('bg-green-700', 'ring-2', 'ring-green-300');
            this.fillToolBtn.classList.add('bg-green-500');
            this.canvas.style.cursor = this.isDrawer ? 'crosshair' : 'not-allowed';
        }
    }

    selectColor(color) {
        // Update the hidden input value
        this.colorPicker.value = color;
        
        // Update visual selection - remove border from all swatches
        document.querySelectorAll('.color-swatch').forEach(swatch => {
            swatch.classList.remove('border-gray-800');
            swatch.classList.add('border-transparent');
        });
        
        // Add border to selected swatch
        const selectedSwatch = document.querySelector(`[data-color="${color}"]`);
        if (selectedSwatch) {
            selectedSwatch.classList.remove('border-transparent');
            selectedSwatch.classList.add('border-gray-800');
        }
    }

    floodFill(startX, startY) {
        const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        const data = imageData.data;
        
        // Convert fill color to RGBA
        const fillColor = this.hexToRgba(this.colorPicker.value);
        
        // Get the color at the starting point
        const startIndex = (startY * this.canvas.width + startX) * 4;
        const startColor = {
            r: data[startIndex],
            g: data[startIndex + 1],
            b: data[startIndex + 2],
            a: data[startIndex + 3]
        };
        
        // If the starting color is the same as fill color, do nothing
        if (this.colorsMatch(startColor, fillColor)) return;
        
        // Perform flood fill using stack-based algorithm
        const stack = [{x: startX, y: startY}];
        const visited = new Set();
        
        while (stack.length > 0) {
            const {x, y} = stack.pop();
            const key = `${x},${y}`;
            
            if (visited.has(key) || x < 0 || x >= this.canvas.width || y < 0 || y >= this.canvas.height) {
                continue;
            }
            
            const index = (y * this.canvas.width + x) * 4;
            const currentColor = {
                r: data[index],
                g: data[index + 1],
                b: data[index + 2],
                a: data[index + 3]
            };
            
            if (!this.colorsMatch(currentColor, startColor)) {
                continue;
            }
            
            visited.add(key);
            
            // Set the new color
            data[index] = fillColor.r;
            data[index + 1] = fillColor.g;
            data[index + 2] = fillColor.b;
            data[index + 3] = 255; // Full alpha
            
            // Add neighboring pixels
            stack.push({x: x + 1, y});
            stack.push({x: x - 1, y});
            stack.push({x, y: y + 1});
            stack.push({x, y: y - 1});
        }
        
        // Apply the changes
        this.ctx.putImageData(imageData, 0, 0);
        
        // Send fill data to other players
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'draw',
                data: { 
                    fill: true, 
                    x: startX, 
                    y: startY, 
                    color: this.colorPicker.value 
                },
                timestamp: Date.now()
            }));
        }
    }

    hexToRgba(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16),
            a: 255
        } : {r: 0, g: 0, b: 0, a: 255};
    }

    colorsMatch(color1, color2) {
        return color1.r === color2.r && color1.g === color2.g && 
               color1.b === color2.b && color1.a === color2.a;
    }

    performFillForOtherPlayer(x, y, color) {
        // Similar to floodFill but using received color and coordinates
        const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        const data = imageData.data;
        
        const fillColor = this.hexToRgba(color);
        const startIndex = (y * this.canvas.width + x) * 4;
        const startColor = {
            r: data[startIndex],
            g: data[startIndex + 1],
            b: data[startIndex + 2],
            a: data[startIndex + 3]
        };
        
        if (this.colorsMatch(startColor, fillColor)) return;
        
        const stack = [{x, y}];
        const visited = new Set();
        
        while (stack.length > 0) {
            const {x: currX, y: currY} = stack.pop();
            const key = `${currX},${currY}`;
            
            if (visited.has(key) || currX < 0 || currX >= this.canvas.width || currY < 0 || currY >= this.canvas.height) {
                continue;
            }
            
            const index = (currY * this.canvas.width + currX) * 4;
            const currentColor = {
                r: data[index],
                g: data[index + 1],
                b: data[index + 2],
                a: data[index + 3]
            };
            
            if (!this.colorsMatch(currentColor, startColor)) {
                continue;
            }
            
            visited.add(key);
            
            data[index] = fillColor.r;
            data[index + 1] = fillColor.g;
            data[index + 2] = fillColor.b;
            data[index + 3] = 255;
            
            stack.push({x: currX + 1, y: currY});
            stack.push({x: currX - 1, y: currY});
            stack.push({x: currX, y: currY + 1});
            stack.push({x: currX, y: currY - 1});
        }
        
        this.ctx.putImageData(imageData, 0, 0);
    }

    openWordListModal() {
        this.wordListModal.classList.remove('hidden');
        // Load current custom words if any
        if (this.customWords) {
            this.customWordsTextarea.value = this.customWords.join('\n');
        }
    }

    closeWordListModal() {
        this.wordListModal.classList.add('hidden');
    }

    saveCustomWords() {
        const wordsText = this.customWordsTextarea.value.trim();
        if (wordsText) {
            // Split by commas or newlines and clean up
            this.customWords = wordsText
                .split(/[,\n]/)
                .map(word => word.trim())
                .filter(word => word.length > 0 && word.length <= 20);
            
            if (this.customWords.length < 10) {
                alert('Please provide at least 10 words for a good game experience.');
                return;
            }
        } else {
            this.customWords = null; // Use default words
        }
        
        this.closeWordListModal();
        
        // Show confirmation
        const wordCount = this.customWords ? this.customWords.length : 'default';
        const message = this.customWords 
            ? `✅ Custom word list saved (${wordCount} words)` 
            : '✅ Using default word list';
        
        // Temporarily show in game status
        const originalStatus = this.gameStatus.textContent;
        this.gameStatus.textContent = message;
        setTimeout(() => {
            this.gameStatus.textContent = originalStatus;
        }, 3000);
    }

    async togglePauseGame() {
        if (!this.isCreator || !this.playerId || !this.roomId) {
            return;
        }

        try {
            const response = await fetch(`/rooms/${this.roomId}/pause`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playerId: this.playerId })
            });

            const data = await response.json();
            if (!response.ok) {
                alert(data.error || 'Failed to pause/resume game');
            }
            // The server will broadcast the pause state change to all players
        } catch (error) {
            console.error('Error toggling pause:', error);
            alert('Failed to pause/resume game');
        }
    }

    handleGamePause(data) {
        const isPaused = data.isPaused;
        
        if (isPaused) {
            // Game is paused
            if (this.isCreator) {
                this.pauseGameBtn.innerHTML = '▶️ Resume';
                this.pauseGameBtn.classList.remove('bg-orange-500', 'hover:bg-orange-600');
                this.pauseGameBtn.classList.add('bg-green-500', 'hover:bg-green-600');
            }
            this.gameStatus.textContent = '⏸️ Game paused by room creator';
            
            // Disable interactions for all players
            this.canvas.classList.add('disabled-canvas');
            this.drawingTools.classList.add('hidden');
            this.chatInput.disabled = true;
            this.chatInput.placeholder = 'Game is paused...';
        } else {
            // Game is resumed
            if (this.isCreator) {
                this.pauseGameBtn.innerHTML = '⏸️ Pause';
                this.pauseGameBtn.classList.remove('bg-green-500', 'hover:bg-green-600');
                this.pauseGameBtn.classList.add('bg-orange-500', 'hover:bg-orange-600');
            }
            
            // Re-enable interactions based on player role
            if (this.isDrawer) {
                this.canvas.classList.remove('disabled-canvas');
                this.drawingTools.classList.remove('hidden');
                this.gameStatus.textContent = '🎨 You are drawing!';
                this.chatInput.disabled = true;
                this.chatInput.placeholder = 'You cannot guess while drawing';
            } else {
                this.gameStatus.textContent = '🤔 Guess the drawing!';
                this.chatInput.disabled = false;
                this.chatInput.placeholder = 'Type your guess...';
            }
        }
        
        this.addChatMessage({
            username: 'System',
            message: isPaused ? '⏸️ Game paused' : '▶️ Game resumed',
            timestamp: Date.now(),
            isGuess: false
        });
    }

    handlePlayerBanned(data) {
        // Remove banned player from stored data
        if (this.playersData && data.bannedPlayerId) {
            delete this.playersData[data.bannedPlayerId];
            this.updatePlayersList(this.playersData);
        }
        
        this.addChatMessage({
            username: 'System',
            message: `🚫 ${data.bannedPlayerName} has been banned from the room`,
            timestamp: Date.now(),
            isGuess: false
        });
    }

    async banPlayer(targetPlayerId) {
        if (!this.isCreator) return;
        
        const targetPlayer = this.playersData?.[targetPlayerId];
        if (!targetPlayer) return;
        
        if (!confirm(`Are you sure you want to ban ${targetPlayer.username}?`)) {
            return;
        }
        
        try {
            const response = await fetch(`/rooms/${this.roomId}/ban`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    requesterId: this.playerId,
                    targetPlayerId: targetPlayerId
                })
            });
            
            if (!response.ok) {
                const error = await response.json();
                alert(`Failed to ban player: ${error.error}`);
            }
        } catch (error) {
            console.error('Error banning player:', error);
            alert('Failed to ban player');
        }
    }

    async leaveRoom() {
        // Clean up timers
        if (this.choiceTimerInterval) {
            clearInterval(this.choiceTimerInterval);
            this.choiceTimerInterval = null;
        }
        
        // Close WebSocket connection
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }

        // Notify server we're leaving
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

        // Reset game state
        this.playerId = null;
        this.roomId = null;
        this.isDrawer = false;
        this.isDrawing = false;
        this.customWords = null;

        this.showHomeScreen();
    }

    handleGameEnd(data) {
        let statusMessage = `🎉 Game Over! Winner: ${data.winner.username}`;
        let chatMessage = `🎉 Game finished! 🥇 Winner: ${data.winner.username}`;
        
        // Handle different end reasons
        if (data.reason === 'Only one player remaining') {
            statusMessage = `🚪 Game ended - only one player remaining`;
            chatMessage = `🚪 Game ended because only one player remained. ${data.winner.username} wins by default!`;
            
            // For single player remaining, return to homepage after a brief delay
            this.gameStatus.textContent = statusMessage;
            this.addChatMessage({
                username: 'System',
                message: chatMessage,
                timestamp: Date.now()
            });
            
            setTimeout(() => {
                this.showHomeScreen();
            }, 3000); // Return to homepage after 3 seconds
            return;
        }
        
        this.gameStatus.textContent = statusMessage;
        
        // Add game end message to chat
        this.addChatMessage({
            username: 'System',
            message: chatMessage,
            timestamp: Date.now()
        });

        // Show winner celebration modal for normal game end
        setTimeout(() => {
            this.showWinnerModal(data.finalScores);
        }, 1000);
    }

    showGameScreen() {
        this.homeScreen.classList.add('hidden');
        this.gameScreen.classList.remove('hidden');
        this.stopStatsRefreshTimer(); // Stop refreshing stats when in game
    }

    showHomeScreen() {
        this.gameScreen.classList.add('hidden');
        this.homeScreen.classList.remove('hidden');
        this.roomInput.value = '';
        this.playerId = null;
        this.roomId = null;
        this.isDrawer = false;
        this.currentDrawerId = null;
        
        // Update URL back to homepage
        this.updateUrl(null);
        
        this.startStatsRefreshTimer(); // Resume refreshing stats when back on homepage
        this.updateHomePageStats(); // Immediate update when returning to homepage
    }

    async startGame() {
        if (!this.isCreator || !this.playerId || !this.roomId) {
            return;
        }

        try {
            const gameSettings = {
                playerId: this.playerId,
                maxRounds: parseInt(this.roundsSetting.value),
                roundDuration: parseInt(this.durationSetting.value),
                wordChoiceCount: parseInt(this.wordChoicesSetting.value),
                customWords: this.customWords || null
            };

            const response = await fetch(`/rooms/${this.roomId}/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(gameSettings)
            });

            const data = await response.json();
            if (response.ok) {
                this.startGameBtn.classList.add('hidden');
                this.gameSettings.classList.add('hidden');
                // Show pause button for room creator
                if (this.isCreator) {
                    this.pauseGameBtn.classList.remove('hidden');
                }
                this.gameStatus.textContent = '🚀 Game starting...';
            } else {
                alert(data.error || 'Failed to start game');
            }
        } catch (error) {
            console.error('Error starting game:', error);
            alert('Failed to start game');
        }
    }

    async showWinnerModal(finalScores) {
        // Get random celebration GIF
        const celebrationGif = await this.getRandomCelebrationGif();
        this.celebrationGif.src = celebrationGif;
        
        // Populate podium with top 3 players
        const topPlayers = finalScores.slice(0, 3);
        
        // First place (always exists)
        if (topPlayers[0]) {
            this.firstPlacePlayer.textContent = topPlayers[0].username;
            this.firstPlaceScore.textContent = `${topPlayers[0].score} pts`;
        }
        
        // Second place (might not exist)
        if (topPlayers[1]) {
            this.secondPlacePlayer.textContent = topPlayers[1].username;
            this.secondPlaceScore.textContent = `${topPlayers[1].score} pts`;
            this.secondPlacePlayer.parentElement.style.display = 'block';
        } else {
            this.secondPlacePlayer.parentElement.style.display = 'none';
        }
        
        // Third place (might not exist)
        if (topPlayers[2]) {
            this.thirdPlacePlayer.textContent = topPlayers[2].username;
            this.thirdPlaceScore.textContent = `${topPlayers[2].score} pts`;
            this.thirdPlacePlayer.parentElement.style.display = 'block';
        } else {
            this.thirdPlacePlayer.parentElement.style.display = 'none';
        }
        
        // Show the modal
        this.winnerModal.classList.remove('hidden');
    }

    closeWinnerModal() {
        this.winnerModal.classList.add('hidden');
    }

    async getRandomCelebrationGif() {
        const celebrationGifs = [
            'https://media.giphy.com/media/26u4cqiYI30juCOGY/giphy.gif',
            'https://media.giphy.com/media/3oz8xAFtqoOUUrsh7W/giphy.gif',
            'https://media.giphy.com/media/26u4kr0pRWGkXaDa0/giphy.gif',
            'https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif',
            'https://media.giphy.com/media/26tOZ42Mg6pbTUPHW/giphy.gif',
            'https://media.giphy.com/media/3o6fJ1BM7R2EBRDnxK/giphy.gif',
            'https://media.giphy.com/media/3oKIPf3C7HqqYBVcCk/giphy.gif',
            'https://media.giphy.com/media/l0HlJUmLPPX99gtuo/giphy.gif',
            'https://media.giphy.com/media/26uf759LlDftqZNVm/giphy.gif',
            'https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif'
        ];
        
        const randomIndex = Math.floor(Math.random() * celebrationGifs.length);
        return celebrationGifs[randomIndex];
    }
}

// Initialize the game when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new GameClient();
});
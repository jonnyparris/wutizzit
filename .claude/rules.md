# Project Rules & Preferences

## User Preferences
- Prefers fun and whimsical UI design with bright colors and gradients
- Likes emoji-based visual elements (avatars, crowns, etc.)
- Values real-time feedback and visual polish
- Appreciates absurd/silly randomness (like funny username generators)
- Wants room creators to have control over game settings

## Technical Patterns
- Use CORS headers carefully - some responses (WebSocket upgrades) have immutable headers
- Always add try-catch around header modifications
- Player lists should be sorted by score (descending) with visual indicators for leaders
- Chat messages should have visual styling and animations
- Use consistent avatar generation based on player ID for persistence

## UI Design Rules
- Background gradients for visual appeal
- Rounded corners (15px+) for friendly feel  
- Box shadows for depth
- Hover animations and transitions
- Color palette: coral (#ff6b6b), yellow (#ffd93d), purple gradients (#667eea, #764ba2)
- Use emoji generously for fun factor

## Game Logic
- Games have 10 rounds by default
- Room creators control game start
- Players get points for correct guesses + time bonus
- Drawer gets points when others guess correctly
- Auto-rotate drawer role between rounds

## Code Organization
- Keep Durable Objects for stateful game logic
- Separate handlers for different API endpoints  
- Real-time updates via WebSocket broadcasting
- Error handling with user-friendly messages
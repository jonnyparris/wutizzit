# Project Goal
Recreate a simplified version of Skribbl.io as a multiplayer drawing and guessing game, built with TypeScript, styled using Tailwind CSS, and deployed on Cloudflare Workers with Durable Objects to coordinate realtime multiplayer interactions.

## Core Features

1.	Rooms & Players
	-	Players can create or join a game room (each room = Durable Object).
	-	Room tracks connected players, usernames, scores, and current round state.
2.	Turn-based Drawing & Guessing
	-	A player is randomly selected as the drawer.
	-	The drawer receives a secret word, draws on a shared canvas.
	-	Other players guess the word via chat. Correct guesses are rewarded with points.
	-	Round timer ensures play moves forward.
3.	Realtime Communication
	-	WebSockets via Durable Objects.
	-	Broadcast drawing strokes to all non-drawers in realtime.
	-	Broadcast guesses, round updates, and score changes.
4.	Frontend (served from Worker)
	-	Canvas for drawing (enabled only for the drawer).
	-	Chat input for guesses.
	-	Sidebar with player list, scores, round timer, and current turn indicator.
	-	Responsive layout styled with Tailwind CSS.
5.	Tech Stack
	-	Backend: Cloudflare Worker + Durable Objects (TypeScript).
	-	Frontend: HTML + TypeScript + Tailwind CSS. All on Cloudflare Worker.
	-	No external DB (state lives inside Durable Objects).

# Project Instructions for Claude Code

## Overview
This is a Cloudflare Worker project that should handle everything.

## Tasks I want you to help with:
- Implement new API endpoints
- Add error handling and logging
- Optimize performance
- Add tests using Vitest
- Deploy to staging/production environments

## Development:
- Local dev: npm run dev
- Build: npm run build
- Deploy: npm run deploy

## Testing:
- Unit tests for handlers and utilities
- Integration tests for Durable Object interactions
- Test commands: npm test, npm run test:watch

## Coding Standards:
- Use TypeScript with strict mode
- Follow RESTful API patterns
- Use Zod for input validation

## File Structure:
- /src/handlers/ - API route handlers
- /src/durable-objects/ - Durable Object classes
- /src/utils/ - Shared utilities
- /src/types/ - TypeScript type definitions

## Architecture:
- Keep handlers in separate files under /src/handlers/
- Use middleware pattern for auth/logging
- Store configuration in wrangler.jsonc

## Cloudflare Specific:
- Use Durable Objects for stateful operations
- Leverage KV for caching when appropriate
- Keep memory usage minimal

## Transparent working:
- update any todo items as you complete them
- add and update any helpful rules or hints to a rules.md in this folder as you learn more about this project and my preferences
- make descriptive git commits as you complete bitesize chunks of new functionality

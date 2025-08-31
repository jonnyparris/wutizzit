import { 
  handleCreateRoom, 
  handleJoinRoom, 
  handleLeaveRoom, 
  handleGetRoomState, 
  handleWebSocket 
} from './handlers/rooms';

export { GameRoomObject } from './durable-objects/GameRoom';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Add CORS headers to all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    try {
      let response: Response;

      // Route handling
      if (url.pathname === '/rooms' && request.method === 'POST') {
        response = await handleCreateRoom(request, env);
      } else if (url.pathname.match(/^\/rooms\/[^\/]+\/join$/) && request.method === 'POST') {
        response = await handleJoinRoom(request, env);
      } else if (url.pathname.match(/^\/rooms\/[^\/]+\/leave$/) && request.method === 'POST') {
        response = await handleLeaveRoom(request, env);
      } else if (url.pathname.match(/^\/rooms\/[^\/]+$/) && request.method === 'GET') {
        response = await handleGetRoomState(request, env);
      } else if (url.pathname.match(/^\/rooms\/[^\/]+\/ws$/) && request.headers.get('Upgrade') === 'websocket') {
        response = await handleWebSocket(request, env);
      } else if (url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname.endsWith('.css') || url.pathname.endsWith('.js') || url.pathname.endsWith('.html')) {
        // Serve static assets
        return fetch(request);
      } else {
        response = new Response('Not Found', { status: 404 });
      }

      // Add CORS headers to the response
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });

      return response;

    } catch (error) {
      console.error('Error handling request:', error);
      const errorResponse = new Response('Internal Server Error', { status: 500 });
      
      Object.entries(corsHeaders).forEach(([key, value]) => {
        errorResponse.headers.set(key, value);
      });

      return errorResponse;
    }
  },
} satisfies ExportedHandler<Env>;

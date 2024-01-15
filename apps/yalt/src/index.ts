import { ClientMessages, createRequestMessage } from '@trigger.dev/yalt';

export interface Env {
	// environemnt variables
	SECRET_KEY: string;
	WORKER_HOST: string;

	// bindings
	connections: DurableObjectNamespace;
	tunnelIds: KVNamespace;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const route = routeUrl(url, env);

		switch (route.type) {
			case 'management': {
				return handleManagementRequest(request, env, ctx);
			}
			case 'tunnel': {
				console.log(`Handling tunnel request for ${route.name}`);

				const id = await env.tunnelIds.get(route.name);

				if (!id) {
					return new Response('Not Found', { status: 404 });
				}

				const tunnel = env.connections.get(env.connections.idFromString(id));
				return tunnel.fetch(request);
			}
			case 'not_found': {
				return new Response('Not Found', { status: 404 });
			}
		}

		return new Response('Not Found', { status: 404 });
	},
};

type RouteDecision =
	| {
			type: 'management';
	  }
	| {
			type: 'tunnel';
			name: string;
	  }
	| { type: 'not_found' };

function routeUrl(url: URL, env: Env): RouteDecision {
	const searchParams = new URLSearchParams(url.search);

	if (searchParams.has('t')) {
		const name = searchParams.get('t');

		if (name) {
			return { type: 'tunnel', name };
		}

		return { type: 'management' };
	}

	if (!url.host.includes(env.WORKER_HOST)) {
		return { type: 'not_found' };
	}

	const parts = url.host.split('.');

	if (parts.length === 2) {
		return { type: 'management' };
	}

	const tunnelName = parts[0];

	if (tunnelName === 'admin') {
		return { type: 'management' };
	}

	if (parts.length === 3) {
		return { type: 'tunnel', name: parts[0] };
	}

	return { type: 'not_found' };
}

async function handleManagementRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const authHeader = request.headers.get('authorization');
	if (!authHeader) {
		return new Response('Authorization header is required', { status: 401 });
	}

	const authHeaderParts = authHeader.split(' ');
	if (authHeaderParts.length !== 2) {
		return new Response('Authorization header is invalid', { status: 401 });
	}

	const [authType, authKey] = authHeaderParts;

	if (authType !== 'Bearer') {
		return new Response('Authorization header is invalid', { status: 401 });
	}

	if (authKey !== env.SECRET_KEY) {
		return new Response('Authorization header is invalid', { status: 401 });
	}

	// Okay now we can actually handle the request
	// We need to look at the path and see what we are doing
	// POST /api/tunnels -> create a new tunnel
	const url = new URL(request.url);

	if (url.pathname === '/api/tunnels' && request.method === 'POST') {
		return handleCreateTunnel(request, env, ctx);
	}

	return new Response('Not Found', { status: 404 });
}

async function handleCreateTunnel(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const tunnelId = env.connections.newUniqueId();
	const tunnelName = crypto.randomUUID();

	await env.tunnelIds.put(tunnelName, tunnelId.toString());

	return new Response(JSON.stringify({ id: tunnelName }), { status: 201 });
}

type Resolver<T> = {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
};

export class YaltConnection implements DurableObject {
	private socket?: WebSocket;
	private responseResolvers: Record<string, Resolver<Response>> = {};

	constructor(
		private state: DurableObjectState,
		private env: Env,
	) {}

	async fetch(request: Request<unknown, CfProperties<unknown>>): Promise<Response> {
		const url = new URL(request.url);

		switch (url.pathname) {
			case '/connect': {
				console.log(`Handling connect request`);

				// This is a request from the client to connect to the tunnel
				if (request.headers.get('Upgrade') !== 'websocket') {
					return new Response('expected websocket', { status: 400 });
				}

				const pair = new WebSocketPair();
				const [clientSocket, serverSocket] = Object.values(pair);

				await this.handleSocket(serverSocket);

				console.log(`Successfully connected to tunnel`);

				return new Response(null, { status: 101, webSocket: clientSocket });
			}
			case '/api/trigger': {
				return this.handleTunnelRequest(request);
			}
			default: {
				return new Response('Not Found', { status: 404 });
			}
		}
	}

	private async handleSocket(socket: WebSocket) {
		if (this.socket) {
			this.socket.close(1000, 'replaced');
		}

		this.socket = socket;

		this.socket.addEventListener('message', (event) => {
			// Here we need to listen for "response" messages from the client and send them to the server via stored promises on this object
			const data = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder('utf-8').decode(event.data));

			const message = ClientMessages.safeParse(data);

			if (!message.success) {
				console.error(message.error);
				return;
			}

			switch (message.data.type) {
				case 'response': {
					const { id, ...response } = message.data;

					const resolver = this.responseResolvers[id];

					if (!resolver) {
						console.error(`No resolver found for ${id}`);
						return;
					}

					delete this.responseResolvers[id];

					resolver.resolve(
						new Response(response.body, {
							status: response.status,
							headers: response.headers,
						}),
					);

					break;
				}
			}
		});

		this.socket.accept();
	}

	private async handleTunnelRequest(request: Request): Promise<Response> {
		if (!this.socket) {
			return createErrorResponse();
		}

		if (this.socket.readyState !== WebSocket.READY_STATE_OPEN) {
			return createErrorResponse();
		}

		const id = crypto.randomUUID();

		const promise = new Promise<Response>((resolve, reject) => {
			this.responseResolvers[id] = { resolve, reject };
		});

		try {
			const message = await createRequestMessage(id, request);
			this.socket.send(JSON.stringify(message));
		} catch (error) {
			console.error(error);
			delete this.responseResolvers[id];

			return createErrorResponse();
		}

		return promise;
	}
}

const createErrorResponse = () =>
	new Response(
		JSON.stringify({
			message: 'Could not connect to your dev server. Make sure you are running the `npx @trigger.dev/cli@latest dev` command',
		}),
		{
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		},
	);

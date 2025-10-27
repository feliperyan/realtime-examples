import { DurableObject } from 'cloudflare:workers';
import { createAdapterLogger } from './shared/log';

/**
 * LiveAgent Durable Object
 * 
 * Orchestrates the flow: STT → (LLM) → TTS
 * For now, implements a simple echo: transcription → TTS
 */
export class LiveAgent extends DurableObject<Env> {
	protected env: Env;
	protected ctx: DurableObjectState;
	private logger: ReturnType<typeof createAdapterLogger>;
	
	// WebSocket for transcription stream from STT adapter
	private transcriptionWS: WebSocket | null = null;
	
	// Session state
	private sessionName: string | null = null;
	private isActive = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.ctx = ctx;
		this.logger = createAdapterLogger('LiveAgent', ctx.id);
		this.logger.log(`LiveAgent created or woken up.`);
	}

	/**
	 * Main fetch handler for LiveAgent endpoints
	 * Routes:
	 *  - POST /<session-name>/live-agent/start
	 *  - POST /<session-name>/live-agent/stop
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathParts = url.pathname.substring(1).split('/').filter((p) => p);

		if (pathParts.length < 2) {
			return new Response('Invalid request path', { status: 400 });
		}

		const sessionName = pathParts[0];
		// pathParts[1] is 'live-agent'
		const action = pathParts.length > 2 ? pathParts[2] : null;

		// Store session name for logging
		if (!this.sessionName) {
			this.sessionName = sessionName;
			this.logger.aliasOnce(sessionName);
		}

		switch (action) {
			case 'start':
				return this.handleStart(sessionName);
			case 'stop':
				return this.handleStop();
			default:
				return new Response('LiveAgent: Use POST /start or /stop', { status: 200 });
		}
	}

	/**
	 * Starts the live agent pipeline:
	 * 1. Connects to STT adapter's transcription stream
	 * 2. Listens for final transcriptions
	 * 3. Echoes them through TTS adapter
	 */
	private async handleStart(sessionName: string): Promise<Response> {
		if (this.isActive) {
			return new Response('LiveAgent already active', { status: 200 });
		}

		try {
			this.logger.log(`Starting LiveAgent for session: ${sessionName}`);

			// Connect to STT transcription stream
			await this.connectToSTTStream(sessionName);

			this.isActive = true;
			this.logger.log(`LiveAgent started successfully`);

			return new Response('LiveAgent started', { status: 200 });
		} catch (error: any) {
			this.logger.error(`Failed to start LiveAgent:`, error.message);
			return new Response(`Failed to start: ${error.message}`, { status: 500 });
		}
	}

	/**
	 * Stops the live agent pipeline
	 */
	private async handleStop(): Promise<Response> {
		if (!this.isActive) {
			return new Response('LiveAgent not active', { status: 200 });
		}

		this.logger.log(`Stopping LiveAgent`);
		this.disconnectSTTStream();
		this.isActive = false;

		return new Response('LiveAgent stopped', { status: 200 });
	}

	/**
	 * Connects to the STT adapter's transcription stream
	 */
	private async connectToSTTStream(sessionName: string): Promise<void> {
		// Get STT adapter stub
		const sttId = this.env.STT_ADAPTER.idFromName(sessionName);
		const sttStub = this.env.STT_ADAPTER.get(sttId);

		// Build WebSocket URL for transcription stream
		// We need to construct a proper request to the STT adapter
		const wsUrl = `https://placeholder/${sessionName}/stt/transcription-stream`;
		const wsRequest = new Request(wsUrl, {
			headers: { Upgrade: 'websocket' },
		});

		// Fetch from STT adapter to get WebSocket
		const response = await sttStub.fetch(wsRequest);

		if (response.status !== 101) {
			throw new Error(`Failed to connect to STT stream: ${response.status}`);
		}

		this.transcriptionWS = response.webSocket;
		if (!this.transcriptionWS) {
			throw new Error('No WebSocket returned from STT adapter');
		}

		this.transcriptionWS.accept();
		this.setupTranscriptionHandlers();

		this.logger.log(`Connected to STT transcription stream`);
	}

	/**
	 * Sets up handlers for transcription WebSocket messages
	 */
	private setupTranscriptionHandlers(): void {
		if (!this.transcriptionWS) return;

		this.transcriptionWS.addEventListener('message', async (event) => {
			try {
				const data = JSON.parse(event.data as string);

				// Handle transcription messages
				if (data.type === 'transcription' && data.data) {
					await this.handleTranscription(data);
				} else if (data.type === 'stt_done') {
					this.logger.log(`STT segment finalized`);
				}
			} catch (error) {
				this.logger.error(`Error handling transcription:`, error);
			}
		});

		this.transcriptionWS.addEventListener('close', () => {
			this.logger.log(`STT transcription stream closed`);
			this.transcriptionWS = null;
		});

		this.transcriptionWS.addEventListener('error', (error) => {
			this.logger.error(`STT transcription stream error:`, error);
		});
	}

	/**
	 * Handles incoming transcription and echoes it through TTS
	 */
	private async handleTranscription(data: any): Promise<void> {
		// Extract transcript text
		const transcript = data.data?.channel?.alternatives?.[0]?.transcript;
		const isFinal = data.data?.is_final || false;

		if (!transcript || !isFinal) {
			// Only process final transcriptions for echo
			return;
		}

		this.logger.log(`Received final transcript: "${transcript}"`);

		// Echo the transcript through TTS
		await this.echoToTTS(transcript);
	}

	/**
	 * Sends text to TTS adapter for speech synthesis
	 */
	private async echoToTTS(text: string): Promise<void> {
		if (!this.sessionName) {
			this.logger.error(`Cannot echo to TTS: no session name`);
			return;
		}

		try {
			this.logger.log(`Echoing to TTS: "${text.substring(0, 50)}..."`);

			// Get TTS adapter stub
			const ttsId = this.env.TTS_ADAPTER.idFromName(this.sessionName);
			const ttsStub = this.env.TTS_ADAPTER.get(ttsId);

			// Send generate request to TTS adapter
			const generateRequest = new Request(`https://placeholder/${this.sessionName}/generate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text }),
			});

			const response = await ttsStub.fetch(generateRequest);

			if (response.status !== 202) {
				throw new Error(`TTS generate failed: ${response.status} ${await response.text()}`);
			}

			this.logger.log(`✅ Echoed to TTS successfully`);
		} catch (error: any) {
			this.logger.error(`Failed to echo to TTS:`, error.message);
		}
	}

	/**
	 * Disconnects from STT transcription stream
	 */
	private disconnectSTTStream(): void {
		if (this.transcriptionWS) {
			this.transcriptionWS.close();
			this.transcriptionWS = null;
		}
	}
}

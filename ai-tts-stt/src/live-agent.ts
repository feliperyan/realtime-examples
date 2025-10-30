// import { DurableObject } from 'cloudflare:workers';
import { createAdapterLogger } from './shared/log';

import { Agent } from "agents";

/**
 * LiveAgent Durable Object
 * 
 * Orchestrates the flow: STT → (LLM) → TTS
 * For now, implements a simple echo: transcription → TTS
 */

// The user in this case is the human speaking to the agent
interface message {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

interface AgentState {
	conversation_log: message[];
	conversation_summary: message[];
	text_messages: message[];
	system_prompt: string;
}

const SYSTEM_PROMPT = `You are a person talking on the phone. You respond with short, simple sentences and act like you are having a phone conversation.
Important: You act as a human being talking on the phone.
Important: You're answers contain no formatting, no markdown, no html, etc.`;

export class LiveAgent extends Agent<Env, AgentState> {

	initialState: AgentState = {
		conversation_log: [],
		conversation_summary: [],	
		text_messages: [],
		system_prompt: SYSTEM_PROMPT
	};

	protected env: Env;
	protected ctx: DurableObjectState;
	private logger: ReturnType<typeof createAdapterLogger>;
	
	// WebSocket for transcription stream from STT adapter
	private transcriptionWS: WebSocket | null = null;
	
	// Session state
	private sessionName: string | null = null;
	private isActive = false;
	
	// Turn detection state
	private pendingLLMResponse: Promise<string> | null = null;
	private lastEagerTranscript: string | null = null;

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
			case 'text-message':				
				const result = await this.handlePseudoTextMessage(request);
				if (result) {
					return new Response(result, { status: 200 });
				}
				else {
					return new Response("error", { status: 500 });
				}
				
			default:
				return new Response('LiveAgent: Use POST /start or /stop', { status: 200 });
		}
	}

    async handlePseudoTextMessage(text: Request | null): Promise<string | null>{
		
		const b = await text?.text();
		
		if (!b) {
		    this.logger.error(`Felipe got no body for text message: ${text}`);
			return null;
		}
        
		this.logger.log(`Received pseudo text message: ${b}`);
		this.setState({
			...this.state,
			text_messages: [...this.state.text_messages, { role: 'user', content: b }],
		});

		return "ok"
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
	 * Handles Flux turn detection events for natural conversation flow
	 */
	private setupTranscriptionHandlers(): void {
		if (!this.transcriptionWS) return;

		this.transcriptionWS.addEventListener('message', async (event) => {
			try {
				const data = JSON.parse(event.data as string);

				// Handle Flux turn detection events
				if (data.type === 'eager_end_of_turn') {
					// User likely finished speaking - can start preparing response
					await this.handleEagerEndOfTurn(data);
				} else if (data.type === 'turn_resumed') {
					// User continued speaking - cancel any pending response
					await this.handleTurnResumed(data);
				} else if (data.type === 'end_of_turn') {
					// Definitive turn end - generate and send response
					await this.handleEndOfTurn(data);
				} else if (data.type === 'transcription' && data.data) {
					// Legacy format or interim updates
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
	 * Handles incoming transcription (legacy format or interim updates)
	 */
	private async handleTranscription(data: any): Promise<void> {
		// Extract transcript text
		const transcript = data.data?.channel?.alternatives?.[0]?.transcript;
		const isFinal = data.data?.is_final || false;

		if (!transcript || !isFinal) {
			// Only log interim updates for debugging
			return;
		}

		this.logger.log(`Received final transcript (legacy): "${transcript}"`);
		
		// Log user message to conversation
		this.setState({
			...this.state,
			conversation_log: [...this.state.conversation_log, { role: 'user', content: transcript }],
		});
		
		// Legacy format - respond immediately (no turn detection)
		const response = await this.getResponseFromLLM(transcript);		
		await this.echoToTTS(response);
	}

	/**
	 * Handles EagerEndOfTurn event from Flux
	 * User likely finished speaking - start preparing response early for lower latency
	 */
	private async handleEagerEndOfTurn(data: any): Promise<void> {
		const transcript = data.data?.transcript || '';
		
		if (!transcript) {
			this.logger.warn(`EagerEndOfTurn with no transcript`);
			return;
		}

		this.logger.log(`🟡 EagerEndOfTurn: "${transcript}"`);
		this.lastEagerTranscript = transcript;

		// Start preparing LLM response early (but don't send yet)
		// This reduces latency when EndOfTurn arrives
		this.pendingLLMResponse = this.getResponseFromLLM(transcript);
		
		// Await the response to catch errors, but don't send to TTS yet
		try {
			await this.pendingLLMResponse;
			this.logger.log(`Pre-generated response ready for turn end`);
		} catch (error) {
			this.logger.error(`Error pre-generating response:`, error);
			this.pendingLLMResponse = null;
		}
	}

	/**
	 * Handles TurnResumed event from Flux
	 * User continued speaking after EagerEndOfTurn - cancel pending response
	 */
	private async handleTurnResumed(data: any): Promise<void> {
		this.logger.log(`🔄 TurnResumed - user continued speaking, canceling pending response`);
		
		// Cancel any pending LLM response since user is still talking
		this.pendingLLMResponse = null;
		this.lastEagerTranscript = null;
	}

	/**
	 * Handles EndOfTurn event from Flux
	 * Definitive turn boundary - send the prepared response or generate new one
	 */
	private async handleEndOfTurn(data: any): Promise<void> {
		const transcript = data.data?.transcript || '';
		const turnIndex = data.data?.turn_index;
		
		if (!transcript) {
			this.logger.warn(`EndOfTurn with no transcript`);
			return;
		}

		this.logger.log(`🟢 EndOfTurn (turn ${turnIndex}): "${transcript}"`);
		
		// Log user message to conversation
		this.setState({
			...this.state,
			conversation_log: [...this.state.conversation_log, { role: 'user', content: transcript }],
		});

		let response: string;

		// Check if we already prepared a response during EagerEndOfTurn
		if (this.pendingLLMResponse && transcript === this.lastEagerTranscript) {
			this.logger.log(`Using pre-generated response from EagerEndOfTurn`);
			try {
				response = await this.pendingLLMResponse;
			} catch (error) {
				this.logger.error(`Pending response failed, generating new:`, error);
				response = await this.getResponseFromLLM(transcript);
			}
		} else {
			// Transcript changed or no pending response - generate fresh
			this.logger.log(`Generating fresh response for EndOfTurn`);
			response = await this.getResponseFromLLM(transcript);
		}

		// Clear state
		this.pendingLLMResponse = null;
		this.lastEagerTranscript = null;

		// Send response to TTS
		await this.echoToTTS(response);
	}

	private async getResponseFromLLM(text: string): Promise<string> {
		// const resp = await this.env.AI.run("@cf/openai/gpt-oss-20b" as any, {
		// 	instructions: "",
		// 	input: text,
		// 	reasoning: {
		// 		effort: "medium",
		// 		summary: "concise"
		// 	}
		// }) as ChatGPTOSS20BResponse;
		
		try {
			// Build messages with full conversation history for better context
			const messages = [
				{role: "system", content: this.state.system_prompt},
				...this.state.conversation_log
			];
			
			this.logger.log(`Sending ${messages.length} messages to LLM (including system prompt)`);
			
			const resp = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
				messages: messages
			});

			this.logger.log(`FelipeLog - response: ${JSON.stringify(resp)}`);
			
			const response = resp.response ? resp.response : "no answer";
			
			// Log assistant message to conversation
			this.setState({
				...this.state,
				conversation_log: [...this.state.conversation_log, { role: 'assistant', content: response }],
			});
			
			return response;
		}
		catch (error) {
			this.logger.error(`FelipeLog = Error getting response from LLM:`, error);
			const errorResponse = "A placeholder text because LLM call failed";
			
			// Log error response to conversation
			this.setState({
				...this.state,
				conversation_log: [...this.state.conversation_log, { role: 'assistant', content: errorResponse }],
			});
			
			return errorResponse;
		}
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


// --------- CHATGPT OSS 20B RESPONSE ---------

/**
 * Represents the main response object from the API.
 */
export interface ChatGPTOSS20BResponse {
    id: string;
    created_at: number;
    instructions: string;
    metadata: unknown | null; // Use unknown for flexibility if structure is not strictly defined, or 'null' if it's strictly null
    model: string;
    object: string; // Likely "response"
    output: OutputItem[];
    parallel_tool_calls: boolean;
    temperature: number;
    tool_choice: string;
    tools: unknown[]; // Array of unknown as the structure is an empty array in the example
    top_p: number;
    background: boolean;
    max_output_tokens: number;
    max_tool_calls: number | null;
    previous_response_id: string | null;
    prompt: string | null;
    reasoning: Reasoning;
    service_tier: string;
    status: string; // Likely "completed"
    text: string | null;
    top_logprobs: number;
    truncation: string; // Likely "disabled"
    usage: Usage;
    user: unknown | null;
}

// --- Nested Interfaces ---

export interface OutputItem {
    id: string;
    content: ContentItem[];
    summary: unknown[]; // Array of unknown as the structure is an empty array in the example
    type: 'reasoning' | 'message'; // Based on the two examples
    encrypted_content: string | null;
    status: string | null;
    role?: 'assistant'; // Only present on 'message' type output, added as optional
}

export interface ContentItem {
    text: string;
    type: 'reasoning_text' | 'output_text';
    annotations?: unknown[]; // Only present on 'output_text' type content, added as optional
    logprobs?: unknown | null; // Only present on 'output_text' type content, added as optional
}

export interface Reasoning {
    effort: string; // Likely "medium"
    generate_summary: unknown | null;
    summary: string; // Likely "concise"
}

export interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}
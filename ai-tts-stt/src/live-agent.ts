import { TTSAdapter } from './tts-adapter';
import { STTAdapter } from './stt-adapter';
import { createAdapterLogger } from './shared/log';

import { DurableObject } from 'cloudflare:workers';

interface LiveAgentState {
    ttsAdapter: TTSAdapter;
    sttAdapter: STTAdapter;    
}

export class LiveAgent extends DurableObject<Env> {
    protected env: Env;
	protected ctx: DurableObjectState;
	private logger: ReturnType<typeof createAdapterLogger>;
    
    constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.ctx = ctx;
		this.logger = createAdapterLogger('LiveAgent', ctx.id);

        this.logger.log(`LiveAgent created or woken up.`);
    }

    
}
	

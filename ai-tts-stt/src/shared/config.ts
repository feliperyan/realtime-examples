/**
 * Shared configuration constants for TTS and STT adapters
 */

// Model names
export const TTS_MODEL = '@cf/deepgram/aura-2-en';
export const STT_MODEL = '@cf/deepgram/flux';

// Timeouts and intervals
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_CLEANUP_GRACE_MS = 100; // 100ms delay for last-client cleanup
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 30000; // 30 seconds

// TTS-specific
export const TTS_BUFFER_CHUNK_SIZE = 16 * 1024; // 16KB - must be less than SFU's 32KB WebSocket message limit

// STT-specific (Flux turn detection parameters)
export const STT_DEBUG_GRACE_MS = 30 * 1000; // 30 seconds
export const STT_MAX_QUEUE_BYTES = 2 * 1024 * 1024; // 2MB safety cap
export const STT_MIN_BATCH_BYTES = 3200; // ~100ms @16kHz mono 16-bit
export const STT_MAX_BATCH_BYTES = 16000; // 500ms @16kHz mono 16-bit
export const STT_MAX_DRAIN_BATCHES_PER_TURN = 8;
export const STT_MAX_DRAIN_SLICE_MS = 10;

// Flux turn detection thresholds
export const FLUX_EAGER_EOT_THRESHOLD = 0.4; // Confidence score (0.3-0.9) - triggers EagerEndOfTurn for low-latency responses
export const FLUX_EOT_THRESHOLD = 0.8; // Confidence score (0.5-0.9) - threshold for definitive EndOfTurn
export const FLUX_EOT_TIMEOUT_MS = 3000; // ms - maximum wait time before forcing EndOfTurn

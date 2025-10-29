# Deepgram Flux Refactor Summary

## Overview
This document summarizes the refactor from Deepgram Nova-3 to Deepgram Flux with native turn detection capabilities.

## Key Changes

### 1. Configuration Updates (`src/shared/config.ts`)

**Changed:**
- Model: `@cf/deepgram/nova-3` → `@cf/deepgram/flux`

**Added:**
- `FLUX_EAGER_EOT_THRESHOLD = 300ms` - Triggers EagerEndOfTurn for low-latency response preparation
- `FLUX_EOT_THRESHOLD = 800ms` - Silence threshold for definitive EndOfTurn
- `FLUX_EOT_TIMEOUT_MS = 2000ms` - Maximum wait time for EndOfTurn

**Removed:**
- `STT_NOVA_KEEPALIVE_MS` - Flux may not require keepalive messages

---

### 2. STT Adapter Connection (`src/stt-adapter.ts`)

#### Connection Method Refactor
**Old (Nova):** Used fetch with WebSocket upgrade header
```typescript
const resp = await fetch(url, {
  headers: {
    Upgrade: 'websocket',
    Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
  },
});
```

**New (Flux):** Uses Workers AI binding with WebSocket mode
```typescript
const resp = await this.env.AI.run(
  STT_MODEL,
  {
    encoding: 'linear16',
    sample_rate: '16000',
    eager_eot_threshold: FLUX_EAGER_EOT_THRESHOLD,
    eot_threshold: FLUX_EOT_THRESHOLD,
    eot_timeout_ms: FLUX_EOT_TIMEOUT_MS,
  },
  { websocket: true }
);
```

#### Message Handler Updates
**Added event type detection:**
- `Update` - Interim transcription updates (~every 0.25s)
- `EagerEndOfTurn` - Early signal that user likely finished speaking
- `TurnResumed` - User continued speaking after EagerEndOfTurn
- `EndOfTurn` - Definitive turn boundary with turn_index

**Added broadcast methods:**
- `broadcastEagerEndOfTurn()`
- `broadcastTurnResumed()`
- `broadcastEndOfTurn()`

#### KeepAlive Changes
- Disabled `scheduleKeepAliveIfPreForwarding()` - Flux's turn detection may not require keepalive
- Simplified alarm handler to just clear keepAlive deadlines
- Left infrastructure in place in case timeouts occur during testing

#### Control Messages
- Kept `Finalize` and `CloseStream` control messages with warning comments
- These may need removal if Flux doesn't support them
- Turn detection should handle session boundaries natively

---

### 3. LiveAgent Turn Detection (`src/live-agent.ts`)

#### State Management
**Added:**
- `pendingLLMResponse: Promise<string> | null` - Tracks pre-generated responses
- `lastEagerTranscript: string | null` - Stores transcript from EagerEndOfTurn

#### Event Handlers

**`handleEagerEndOfTurn()`**
- Fires when user likely finished speaking
- Starts preparing LLM response immediately for lower latency
- Does NOT send to TTS yet - waits for EndOfTurn confirmation

**`handleTurnResumed()`**
- Fires if user continues speaking after EagerEndOfTurn
- Cancels any pending LLM response
- Prevents interrupting the user mid-thought

**`handleEndOfTurn()`**
- Fires on definitive turn boundary
- Uses pre-generated response if transcript matches EagerEndOfTurn
- Generates fresh response if transcript changed
- Sends final response to TTS

**`handleTranscription()` (legacy)**
- Now only handles legacy Nova format
- Maintains backward compatibility

#### Conversation Flow
```
User speaks: "Hi I need to cancel..."
  ↓
Update events (interim transcripts)
  ↓
EagerEndOfTurn: "Hi I need to cancel my subscription"
  → Agent starts preparing response (doesn't send yet)
  ↓
User pauses briefly, then: "...please"
  ↓
TurnResumed: Agent cancels pending response
  ↓
Update events continue
  ↓
EndOfTurn: "Hi I need to cancel my subscription please"
  → Agent generates new response and sends to TTS
```

---

## Benefits of Turn Detection

### 1. Lower Latency
- Agent begins preparing response during `EagerEndOfTurn`
- Response ready immediately when `EndOfTurn` arrives
- Reduces perceived response time

### 2. Natural Conversation
- No more interrupting users mid-sentence
- Agent waits for definitive turn boundaries
- Handles pauses and continuations gracefully

### 3. Simpler Logic
- No manual VAD or silence detection needed
- Turn detection handled natively by Flux
- Reduces complexity in application code

---

## TypeScript Notes

The Workers AI binding types don't yet include `@cf/deepgram/flux`, so we use:
```typescript
// @ts-ignore - Flux model not yet in AI binding types
```

This can be removed once the types are updated.

---

## Testing Checklist

- [ ] Verify Flux WebSocket connects successfully
- [ ] Confirm turn detection events fire (Update, EagerEndOfTurn, TurnResumed, EndOfTurn)
- [ ] Test EagerEndOfTurn → EndOfTurn happy path (no interruption)
- [ ] Test EagerEndOfTurn → TurnResumed → EndOfTurn (user continues)
- [ ] Verify pending response cancellation works
- [ ] Test reconnection logic still works
- [ ] Confirm control messages (Finalize/CloseStream) don't cause errors
- [ ] Validate latency improvement from pre-generated responses
- [ ] Test with various speech patterns (pauses, interruptions, long turns)
- [ ] Verify alarm/hibernation still works correctly

---

## Potential Issues & Mitigations

### 1. Control Messages
**Issue:** Flux may not support `Finalize`/`CloseStream` control messages  
**Mitigation:** Added warning comments; errors are caught and logged; can remove if needed

### 2. KeepAlive
**Issue:** Disabled keepalive may cause connection timeouts  
**Mitigation:** Infrastructure left in place; can re-enable if timeouts occur

### 3. Type Safety
**Issue:** Flux not in Workers AI types yet  
**Mitigation:** Using `@ts-ignore` with clear comments; update when types available

### 4. Legacy Compatibility
**Issue:** Old Nova format may still arrive  
**Mitigation:** `handleTranscription()` still handles legacy format

---

## Future Optimizations

1. **Conversation Context:** Track turn history for multi-turn conversations
2. **Response Streaming:** Stream LLM response to TTS during generation
3. **Interruption Handling:** Allow user to interrupt agent's response
4. **Adaptive Thresholds:** Tune EOT thresholds based on conversation patterns
5. **Metrics:** Track turn detection accuracy and response latency

---

## Documentation Updates Needed

- Update `STTAdapter.md` with Flux-specific state machines
- Add turn detection event flow diagrams
- Document EagerEndOfTurn strategy and benefits
- Update timing considerations for Flux


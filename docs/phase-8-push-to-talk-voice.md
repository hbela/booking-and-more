This is the plan and execution record for Epic 8 — the customer half: pressing a button, speaking, and
getting a booking, over the conversation Epic 7 already built.

# Phase 8 — Push-to-talk voice

## Implementation Record

**Document version:** 1.0 — planned 2026-08-10.
**Scope:** the audio upload route and its validation; `OpenAITranscriptionProvider`; the `voice_interactions`
record; the `PushToTalkButton` and its recording state machine; transcript review before submission; device
speech synthesis; the fallback when there is no microphone; the sweeps that delete audio and expire
transcripts.
**Depends on:** [phase-7-chat-booking.md](phase-7-chat-booking.md) for the conversation, its token, the tool
allowlist and the metering gate — this slice adds one transport to it and nothing else.
**Delivers PRD:** §8.3 push-to-talk mode · §9.11 · §10.1 · §10.5 · §11 · §12.4 · §14 · tech-impl §10.19,
§18.2, §19, §33, §34.3, §35, §44 Epic 8.
**Exit criteria:** A customer searches and books by push-to-talk · Voice and chat share one conversation state
machine · Voice usage is metered per tenant against the same quota · Raw recordings are deleted per policy.

---

# 1. Voice is a transport, not a mode

The only thing this slice adds to the conversation is a way for a turn's text to arrive:

```
audio  →  POST …/transcriptions  →  transcript  →  (customer reviews)  →  POST …/messages
```

The second half is the endpoint chat already uses, unchanged. There is no voice state machine, no voice tool
path, no voice branch in the service. `channel` on the session records how the customer is talking to us, and
the `voice_interactions` row records what one recording cost — nothing else in the system is aware.

This is deliberate and it is the epic's own exit criterion. PRD §4.2 states the principle: *forms, chat, and
voice use the same backend operations.* The cheapest way to keep that true is to make it structurally
impossible to violate.

---

# 2. Transcription and interpretation are two requests

The transcription route returns the transcript and stops. It does not interpret, does not call a tool, and
does not change the conversation's state.

PRD §10.1 requires it: the customer sees what was heard, and can accept, edit, re-record or cancel before
anything happens. Submitting the transcript is a separate act, and it is the same act as typing.

The practical consequence is that a misheard utterance costs one transcription rather than a wrong booking,
and that the correction path is the chat input the customer already has. It also means the interpretation
step never has to know whether its text was typed or spoken, which is what keeps §1 true.

---

# 3. Validating the upload before spending anything

tech-impl §34.3, in this order, all before the provider is called:

1. Content type in `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/wav`.
2. Magic-byte sniff — the declared type is a claim, not a fact.
3. Size against `VOICE_MAX_UPLOAD_BYTES`.
4. Duration against `VOICE_MAX_DURATION_SECONDS` (30, already in `@bam/config` since Phase 0).
5. Session ownership — the `X-Conversation-Token` header, as everywhere else.
6. The metering gate, `assertAllowed({ category: VOICE_TRANSCRIPTION, requestedQuantity: seconds })`.

Only then does the audio go to OpenAI. Every one of those checks is cheaper than the call it guards, which is
the whole point of the ordering; the rate limit (10/min per session, tech-impl §33) is cheaper still and sits
in front of all of them.

`@fastify/multipart` is a new dependency. The API has never accepted a file upload before, and the 1 MiB
`bodyLimit` set in `app.ts` does not apply to multipart parts — the size check above is the one that counts.

---

# 4. The recording never lands anywhere

While `VOICE_AUDIO_RETENTION_ENABLED` is false — its default, and the only supported setting in this slice —
the audio buffer goes from the request straight to the provider and is dropped. It is not written to disk, not
put in object storage, and not held in a queue.

That is tech-impl §35 and PRD §14, and it is also the cheapest possible implementation of them: there is no
deletion job for a thing that was never stored. The `audio_retained` column on `voice_interactions` records
`false` for every row this slice writes, and exists so that turning retention on later is a change to one
branch rather than a schema migration.

The transcript is retained for 30 days and then nulled by the sweep. The row survives — it carries the cost
and duration that the usage figures were built from, and deleting it would make a month's spend
unreconcilable.

---

# 5. The button and its states

tech-impl §19.1's union, implemented as written:

```
IDLE → REQUESTING_PERMISSION → RECORDING → UPLOADING → TRANSCRIBING → REVIEWING → PROCESSING
                                    ↘ ERROR ↙
```

`RECORDING` shows elapsed time against the 30-second cap and can be cancelled — a customer who starts
speaking and changes their mind must not have to wait for a timeout, and a cancelled recording is never
uploaded, so it costs nothing.

**The AI disclosure comes before the first recording**, once per session (PRD §9.11). Speech is sent to a
third party; the customer is told before it happens, not in a footer.

**No `MediaRecorder`, no microphone button** (tech-impl §19.3). The chat input stays, the form stays, and
nothing about the page announces a capability the browser does not have. This is the same fallback the
missing-API-key and over-quota paths take, which is why it is one code path and not three.

---

# 6. Speaking back is the device's job

`window.speechSynthesis`, or nothing (PRD §10.5). No paid TTS provider in this slice.

PRD §11 lists device TTS as a cost control and it is the strongest one available: spoken output becomes free
and offline. It is also optional — every reply is on screen first, and §4.4's requirement that visual
confirmation accompany voice means the spoken version is never the only version.

`TTS_CHARACTERS` exists in the usage categories for the day that changes. Nothing writes it yet.

---

# 7. Accessibility is the same requirement as the fallback

PRD §12.4 — a form fallback for every voice action — is satisfied by the fact that the panel drives the same
`Step` machine the taps do. Beyond that: the microphone button is keyboard-operable (it is a button, not a
press-and-hold gesture with no keyboard equivalent), assistant messages are in an `aria-live` region, and the
transcript is an editable text field rather than a read-only banner.

A customer who cannot use a microphone, cannot hear the reply, or is on a browser that has neither loses no
capability. That is the test.

---

# 8. The duration is a claim, and that is on purpose

`validateAudio` takes the recorder's own `durationMs` as a multipart field rather than decoding the
container. Decoding four audio formats server-side means a native dependency, in a request path whose
whole point is to be cheap — and the figure would still only be used for metering.

What actually bounds the spend is the pair of limits either side of the claim: `VOICE_MAX_UPLOAD_BYTES`
here and 10 uploads a minute per session on the route. A client that lies cannot exceed ten uploads a
minute of at most 5 MB each, whatever it says about them. A claim over `VOICE_MAX_DURATION_SECONDS` is
refused outright, and a missing one is billed as a second rather than as nothing.

If that ever stops being good enough, the honest upgrade is to measure it — not to trust the claim
harder.

---

# 9. What was built

| Area | Files |
|---|---|
| Upload validation | `apps/api/src/modules/public/audio.ts` — `sniffAudio`, `validateAudio` |
| Route | `POST /v1/public/conversations/:id/transcriptions` in `conversation.routes.ts`, `@fastify/multipart` registered inside that plugin only |
| Service | `ConversationService.transcribe` — quota gate, provider call, `usage_events`, `voice_interactions` |
| Provider | `packages/ai/src/transcription.ts` (`OpenAITranscriptionProvider`), `FakeTranscriptionProvider` |
| Sweeps | `apps/worker/src/conversations/conversation.sweeper.ts` — session and pending-action expiry, orphaned-hold release, 30-day transcript erasure |
| Web | `components/push-to-talk-button.tsx` (RecordingState, elapsed counter, Escape to abandon, `speak()`), transcript review inside `conversation-panel.tsx` |
| Tests | `apps/api/src/voice.test.ts` (15), `apps/worker/src/conversations/conversation.sweeper.test.ts` (5) |

The microphone is a **toggle, not a press-and-hold gesture**: a gesture has no keyboard equivalent,
and PRD §12.4 is not satisfied by a control only a mouse can operate.

---

# 10. What this slice does not do

Provider voice commands (PRD §31, tech-impl §44 Epic 8's other half) — goal #1, a separate slice, and the
reason this document says "customer half" in its first line. Realtime speech-to-speech (PRD §8.4) — excluded
from MVP by PRD §23. Telephone integration. Paid cloud TTS. Audio retention to object storage.

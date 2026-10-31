import type {
  ClaudeAgentEvent,
  ClaudeAgentSession,
  ClaudeAgentTransport,
  ClaudeSessionRequest,
} from "./claude-agent-runtime.ts";

/** Decides what one fake agent session emits; resolving late (or never) simulates a slow agent. */
export type ClaudeTranscript = (
  request: ClaudeSessionRequest,
) => ClaudeAgentEvent[] | Promise<ClaudeAgentEvent[]>;

export interface FakeClaudeSessionState {
  interrupts: number;
  kills: number;
  closed: boolean;
}

export interface FakeClaudeTransport extends ClaudeAgentTransport {
  /** Every session request, in order (credentials included, so tests can assert which key was used). */
  readonly requests: ClaudeSessionRequest[];
  readonly sessions: FakeClaudeSessionState[];
}

/**
 * In-memory ClaudeAgentTransport for CI and dev: no process, no network. Each session emits the
 * transcript's events and then exits; an interrupt or kill ends it at once, as a real process would.
 */
export function createFakeClaudeTransport(transcript: ClaudeTranscript): FakeClaudeTransport {
  const requests: ClaudeSessionRequest[] = [];
  const sessions: FakeClaudeSessionState[] = [];
  return {
    requests,
    sessions,
    start(request): ClaudeAgentSession {
      requests.push(request);
      const state: FakeClaudeSessionState = { interrupts: 0, kills: 0, closed: false };
      sessions.push(state);
      let markClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        markClosed = () => {
          state.closed = true;
          resolve();
        };
      });
      const stopped = closed.then(() => "stopped" as const);
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            try {
              const events = await Promise.race([Promise.resolve(transcript(request)), stopped]);
              if (events === "stopped") return;
              for (const event of events) {
                if (state.closed) return;
                yield event;
              }
            } finally {
              markClosed();
            }
          },
        },
        interrupt() {
          state.interrupts++;
          markClosed();
        },
        kill() {
          state.kills++;
          markClosed();
        },
        closed,
      };
    },
  };
}

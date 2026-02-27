// @vitest-environment jsdom
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * Tests for the useAudioRecorder hook which manages browser microphone recording,
 * MediaRecorder lifecycle, and Deepgram transcription via the api module.
 *
 * The hook transitions through these states:
 *   idle -> requesting -> recording -> (stop) -> transcribing -> idle
 *                                    -> (cancel) -> idle
 *                                    -> (error) -> error -> idle (after 3s)
 *
 * We mock:
 *   - navigator.mediaDevices.getUserMedia (returns a mock MediaStream)
 *   - MediaRecorder (controllable mock that lets us trigger ondataavailable/onstop)
 *   - api.transcribeAudio (the Deepgram transcription endpoint)
 *
 * Important: We use vi.useFakeTimers({ shouldAdvanceTime: true }) so that
 * waitFor() polling still works (it relies on real setTimeout), while
 * giving us vi.advanceTimersByTime() for testing the 60s max timeout
 * and the 3s error-to-idle reset.
 */

// ---------------------------------------------------------------------------
// Mock the api module
// ---------------------------------------------------------------------------
const mockTranscribeAudio = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    transcribeAudio: (...args: unknown[]) => mockTranscribeAudio(...args),
  },
}));

import { useAudioRecorder } from "./use-audio-recorder.js";

// ---------------------------------------------------------------------------
// Mock MediaRecorder
// ---------------------------------------------------------------------------

// Holds the most recently constructed MockMediaRecorder instance so tests
// can trigger ondataavailable/onstop on it after startRecording is called.
let mockRecorderInstance: MockMediaRecorder | null = null;

class MockMediaRecorder {
  state = "inactive" as string;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "audio/webm";
    mockRecorderInstance = this;
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    // Simulate the browser firing ondataavailable then onstop synchronously.
    // Tests can override ondataavailable before calling stop for custom behavior.
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(["audio-data"], { type: this.mimeType }) });
    }
    if (this.onstop) {
      this.onstop();
    }
  }

  static isTypeSupported = vi.fn().mockReturnValue(true);
}

// ---------------------------------------------------------------------------
// Mock MediaStream
// ---------------------------------------------------------------------------

function createMockStream(): MediaStream & { _mockTrack: { stop: ReturnType<typeof vi.fn> } } {
  const mockTrack = { stop: vi.fn(), kind: "audio" };
  return {
    getTracks: () => [mockTrack],
    // Keep a reference so tests can assert tracks were stopped
    _mockTrack: mockTrack,
  } as unknown as MediaStream & { _mockTrack: { stop: ReturnType<typeof vi.fn> } };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let mockStream: ReturnType<typeof createMockStream>;

beforeEach(() => {
  vi.clearAllMocks();
  // shouldAdvanceTime: true lets waitFor() polling work normally while
  // still allowing vi.advanceTimersByTime() for explicit timer control
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockRecorderInstance = null;

  mockStream = createMockStream();

  // Install the mock MediaRecorder globally
  globalThis.MediaRecorder = MockMediaRecorder as unknown as typeof MediaRecorder;

  // Mock getUserMedia to resolve with our mock stream
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia: vi.fn().mockResolvedValue(mockStream),
    },
    writable: true,
    configurable: true,
  });

  // Default: transcription succeeds with some text
  mockTranscribeAudio.mockResolvedValue({ text: "hello world" });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helper: start a recording and wait for state to become "recording"
// ---------------------------------------------------------------------------
async function startAndWaitForRecording(
  result: { current: ReturnType<typeof useAudioRecorder> },
) {
  await act(async () => {
    result.current.startRecording();
  });
  // startRecording is async internally (getUserMedia); flush microtask queue
  await waitFor(() => {
    expect(result.current.state).toBe("recording");
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useAudioRecorder", () => {
  // ─── Initial state ──────────────────────────────────────────────────

  it("returns idle state on initial render", () => {
    // The hook should start in the "idle" state with callable functions
    const { result } = renderHook(() =>
      useAudioRecorder({
        onTranscript: vi.fn(),
        onError: vi.fn(),
      }),
    );

    expect(result.current.state).toBe("idle");
    expect(typeof result.current.startRecording).toBe("function");
    expect(typeof result.current.stopRecording).toBe("function");
    expect(typeof result.current.cancelRecording).toBe("function");
  });

  // ─── startRecording: happy path ─────────────────────────────────────

  it("transitions from idle -> requesting -> recording on startRecording", async () => {
    // Validates the full state transition when microphone access is granted
    // and MediaRecorder is created and started
    const { result } = renderHook(() =>
      useAudioRecorder({
        onTranscript: vi.fn(),
        onError: vi.fn(),
      }),
    );

    expect(result.current.state).toBe("idle");

    await startAndWaitForRecording(result);

    // getUserMedia should have been called requesting audio
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });

    // MediaRecorder should have been constructed and started
    expect(mockRecorderInstance).not.toBeNull();
    expect(mockRecorderInstance!.state).toBe("recording");
  });

  it("uses audio/webm;codecs=opus when isTypeSupported returns true", async () => {
    // The hook checks MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    // and uses that preferred MIME type when supported
    MockMediaRecorder.isTypeSupported.mockReturnValue(true);

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError: vi.fn() }),
    );

    await startAndWaitForRecording(result);

    expect(mockRecorderInstance!.mimeType).toBe("audio/webm;codecs=opus");
  });

  it("falls back to audio/webm when isTypeSupported returns false", async () => {
    // When the opus codec isn't supported, it should fall back to plain audio/webm
    MockMediaRecorder.isTypeSupported.mockReturnValue(false);

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError: vi.fn() }),
    );

    await startAndWaitForRecording(result);

    expect(mockRecorderInstance!.mimeType).toBe("audio/webm");
  });

  // ─── stopRecording: successful transcription ────────────────────────

  it("transitions recording -> transcribing -> idle on successful transcription", async () => {
    // Full flow: start recording, stop, verify transcription is called,
    // onTranscript receives the text, and state returns to idle
    const onTranscript = vi.fn();
    const onError = vi.fn();
    mockTranscribeAudio.mockResolvedValue({ text: "transcribed text" });

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript, onError }),
    );

    await startAndWaitForRecording(result);

    // Stop the recording — this triggers onstop which calls transcribeAudio
    await act(async () => {
      result.current.stopRecording();
    });

    // Wait for the async transcription to complete
    await waitFor(() => {
      expect(result.current.state).toBe("idle");
    });

    // transcribeAudio should have been called with a Blob
    expect(mockTranscribeAudio).toHaveBeenCalledTimes(1);
    const callArgs = mockTranscribeAudio.mock.calls[0];
    expect(callArgs[0]).toBeInstanceOf(Blob);

    // onTranscript should have been called with the transcribed text
    expect(onTranscript).toHaveBeenCalledWith("transcribed text");
    expect(onError).not.toHaveBeenCalled();
  });

  it("passes keywords to api.transcribeAudio", async () => {
    // When the hook is initialized with keywords, those should be forwarded
    // to the transcription API call
    const onTranscript = vi.fn();
    mockTranscribeAudio.mockResolvedValue({ text: "result" });

    const { result } = renderHook(() =>
      useAudioRecorder({
        onTranscript,
        onError: vi.fn(),
        keywords: "Claude,Anthropic",
      }),
    );

    await startAndWaitForRecording(result);

    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("idle");
    });

    expect(mockTranscribeAudio).toHaveBeenCalledWith(
      expect.any(Blob),
      "Claude,Anthropic",
    );
  });

  it("does not call onTranscript when transcription returns empty/whitespace text", async () => {
    // If the transcription result is empty or only whitespace, onTranscript
    // should not be called, but the state should still return to idle
    const onTranscript = vi.fn();
    mockTranscribeAudio.mockResolvedValue({ text: "   " });

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript, onError: vi.fn() }),
    );

    await startAndWaitForRecording(result);

    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("idle");
    });

    // transcribeAudio was called, but onTranscript was NOT called because text was whitespace
    expect(mockTranscribeAudio).toHaveBeenCalledTimes(1);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  // ─── stopRecording: transcription error ─────────────────────────────

  it("calls onError and transitions to error state when transcription fails", async () => {
    // When api.transcribeAudio rejects, onError should be called with the
    // error message, state should go to "error", then auto-reset to "idle"
    // after 3 seconds
    const onError = vi.fn();
    mockTranscribeAudio.mockRejectedValue(new Error("Transcription failed"));

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError }),
    );

    await startAndWaitForRecording(result);

    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("error");
    });

    expect(onError).toHaveBeenCalledWith("Transcription failed");

    // After 3 seconds, state should auto-reset to idle
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.state).toBe("idle");
  });

  it("handles non-Error transcription failures by converting to string", async () => {
    // When the transcription promise rejects with a non-Error value (e.g. a string),
    // the hook should convert it to a string via String()
    const onError = vi.fn();
    mockTranscribeAudio.mockRejectedValue("string error");

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError }),
    );

    await startAndWaitForRecording(result);

    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("error");
    });

    expect(onError).toHaveBeenCalledWith("string error");
  });

  // ─── Empty blob (no audio data) ────────────────────────────────────

  it("returns to idle without transcribing when blob is empty", async () => {
    // If the MediaRecorder produces no data (blob.size === 0), the hook
    // should skip transcription and go directly back to idle
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript, onError: vi.fn() }),
    );

    await startAndWaitForRecording(result);

    // Override the stop behavior to produce an empty blob (no ondataavailable call).
    // When no chunks are collected, new Blob([], ...) produces a zero-size blob.
    const recorder = mockRecorderInstance!;
    const originalOnstop = recorder.onstop;
    recorder.stop = function (this: MockMediaRecorder) {
      this.state = "inactive";
      // Do NOT call ondataavailable — simulates no audio data captured.
      // Call onstop directly to trigger the transcription path.
      if (originalOnstop) {
        originalOnstop();
      }
    };

    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("idle");
    });

    // transcribeAudio should NOT have been called since blob was empty
    expect(mockTranscribeAudio).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  // ─── cancelRecording ───────────────────────────────────────────────

  it("cancels recording without transcribing and returns to idle", async () => {
    // cancelRecording should nullify onstop (preventing transcription),
    // stop the recorder, clean up streams, and set state to idle
    const onTranscript = vi.fn();

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript, onError: vi.fn() }),
    );

    await startAndWaitForRecording(result);

    act(() => {
      result.current.cancelRecording();
    });

    expect(result.current.state).toBe("idle");

    // Transcription should never have been called
    expect(mockTranscribeAudio).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  // ─── getUserMedia errors ───────────────────────────────────────────

  it("handles NotAllowedError with 'Microphone permission denied' message", async () => {
    // When the user denies microphone permission, the hook should report
    // a user-friendly error message
    const onError = vi.fn();
    const permissionError = new DOMException("Permission denied", "NotAllowedError");
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(
      permissionError,
    );

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError }),
    );

    await act(async () => {
      result.current.startRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("error");
    });

    expect(onError).toHaveBeenCalledWith("Microphone permission denied");

    // After 3 seconds, state should auto-reset to idle
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.state).toBe("idle");
  });

  it("handles NotFoundError with 'No microphone found' message", async () => {
    // When no audio input device is available, the hook should report
    // a user-friendly error
    const onError = vi.fn();
    const notFoundError = new DOMException("No devices found", "NotFoundError");
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(
      notFoundError,
    );

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError }),
    );

    await act(async () => {
      result.current.startRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("error");
    });

    expect(onError).toHaveBeenCalledWith("No microphone found");
  });

  it("handles generic getUserMedia errors with the error message", async () => {
    // For unexpected errors from getUserMedia (not NotAllowed/NotFound),
    // the hook should pass through the error message directly
    const onError = vi.fn();
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Something went wrong"),
    );

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError }),
    );

    await act(async () => {
      result.current.startRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("error");
    });

    expect(onError).toHaveBeenCalledWith("Something went wrong");
  });

  it("handles non-Error getUserMedia rejections by converting to string", async () => {
    // If getUserMedia rejects with a non-Error (unlikely but defensive),
    // the hook should convert it with String()
    const onError = vi.fn();
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(
      42,
    );

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError }),
    );

    await act(async () => {
      result.current.startRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("error");
    });

    expect(onError).toHaveBeenCalledWith("42");
  });

  // ─── Guards against double-start ───────────────────────────────────

  it("does not start when already in recording state", async () => {
    // Calling startRecording while already recording should be a no-op
    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError: vi.fn() }),
    );

    await startAndWaitForRecording(result);

    // Reset the mock to track new calls
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockClear();

    await act(async () => {
      result.current.startRecording();
    });

    // getUserMedia should NOT have been called a second time
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(result.current.state).toBe("recording");
  });

  it("does not start when in transcribing state", async () => {
    // While audio is being transcribed, startRecording should be a no-op.
    // We achieve the "transcribing" state by stopping the recorder with a
    // transcribeAudio that never resolves during the test.
    let resolveTranscription!: (val: { text: string }) => void;
    mockTranscribeAudio.mockReturnValue(
      new Promise((resolve) => {
        resolveTranscription = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError: vi.fn() }),
    );

    await startAndWaitForRecording(result);

    // Stop recording to trigger onstop -> transcribing state
    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("transcribing");
    });

    // Now try to start again — should be a no-op
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockClear();

    await act(async () => {
      result.current.startRecording();
    });

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(result.current.state).toBe("transcribing");

    // Clean up by resolving the pending transcription
    await act(async () => {
      resolveTranscription({ text: "" });
    });
  });

  // ─── stopRecording when not recording ──────────────────────────────

  it("stopRecording is a no-op when not recording", () => {
    // Calling stopRecording when idle should not throw or cause errors
    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError: vi.fn() }),
    );

    // Should not throw
    act(() => {
      result.current.stopRecording();
    });

    expect(result.current.state).toBe("idle");
  });

  // ─── cancelRecording when not recording ────────────────────────────

  it("cancelRecording from idle is a safe no-op", () => {
    // Calling cancelRecording when there's nothing to cancel should just
    // ensure state remains idle without errors
    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError: vi.fn() }),
    );

    act(() => {
      result.current.cancelRecording();
    });

    expect(result.current.state).toBe("idle");
  });

  // ─── Max recording duration auto-stop ──────────────────────────────

  it("auto-stops recording after MAX_RECORDING_MS (60s)", async () => {
    // The hook sets a 60-second timeout that auto-stops the MediaRecorder.
    // We verify that advancing timers past 60s triggers recorder.stop().
    const onTranscript = vi.fn();
    mockTranscribeAudio.mockResolvedValue({ text: "auto-stopped" });

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript, onError: vi.fn() }),
    );

    await startAndWaitForRecording(result);

    // Advance time past the 60-second max duration
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // The recorder should have been stopped and transcription should proceed
    await waitFor(() => {
      expect(result.current.state).toBe("idle");
    });

    expect(onTranscript).toHaveBeenCalledWith("auto-stopped");
  });

  // ─── Cleanup on unmount ────────────────────────────────────────────

  it("stops recording and cleans up on unmount", async () => {
    // When the component unmounts while recording, the hook should stop
    // the MediaRecorder (with onstop nullified to prevent transcription)
    // and release the media stream
    const { result, unmount } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError: vi.fn() }),
    );

    await startAndWaitForRecording(result);

    const recorder = mockRecorderInstance!;
    // Spy on the actual stop method
    const stopSpy = vi.spyOn(recorder, "stop");

    unmount();

    // The recorder's stop should have been called during cleanup
    expect(stopSpy).toHaveBeenCalled();

    // The onstop handler should have been nullified before stopping
    // (to prevent transcription during unmount)
    expect(recorder.onstop).toBeNull();
  });

  it("cleans up stream tracks on unmount", async () => {
    // Verify that the media stream tracks are stopped when the hook unmounts
    const { result, unmount } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError: vi.fn() }),
    );

    await startAndWaitForRecording(result);

    unmount();

    // Stream tracks should have been stopped during cleanup
    expect(mockStream._mockTrack.stop).toHaveBeenCalled();
  });

  // ─── Callback ref updates ──────────────────────────────────────────

  it("uses the latest onTranscript callback even if it changes between start and stop", async () => {
    // The hook stores callbacks in refs so the onstop closure always uses
    // the most current version. This test verifies that behavior.
    const onTranscript1 = vi.fn();
    const onTranscript2 = vi.fn();
    mockTranscribeAudio.mockResolvedValue({ text: "result" });

    const { result, rerender } = renderHook(
      (props: { onTranscript: (text: string) => void }) =>
        useAudioRecorder({
          onTranscript: props.onTranscript,
          onError: vi.fn(),
        }),
      { initialProps: { onTranscript: onTranscript1 } },
    );

    await startAndWaitForRecording(result);

    // Change the onTranscript callback mid-recording
    rerender({ onTranscript: onTranscript2 });

    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("idle");
    });

    // The NEW callback (onTranscript2) should have been called, not the original
    expect(onTranscript1).not.toHaveBeenCalled();
    expect(onTranscript2).toHaveBeenCalledWith("result");
  });

  it("uses the latest onError callback even if it changes", async () => {
    // Same ref-update pattern for onError
    const onError1 = vi.fn();
    const onError2 = vi.fn();
    mockTranscribeAudio.mockRejectedValue(new Error("fail"));

    const { result, rerender } = renderHook(
      (props: { onError: (err: string) => void }) =>
        useAudioRecorder({
          onTranscript: vi.fn(),
          onError: props.onError,
        }),
      { initialProps: { onError: onError1 } },
    );

    await startAndWaitForRecording(result);

    // Change the onError callback mid-recording
    rerender({ onError: onError2 });

    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("error");
    });

    // The NEW callback should have been invoked
    expect(onError1).not.toHaveBeenCalled();
    expect(onError2).toHaveBeenCalledWith("fail");
  });

  it("uses the latest keywords ref value at transcription time", async () => {
    // If keywords change between starting and stopping, the latest value
    // should be passed to api.transcribeAudio
    mockTranscribeAudio.mockResolvedValue({ text: "result" });

    const { result, rerender } = renderHook(
      (props: { keywords?: string }) =>
        useAudioRecorder({
          onTranscript: vi.fn(),
          onError: vi.fn(),
          keywords: props.keywords,
        }),
      { initialProps: { keywords: "initial" } },
    );

    await startAndWaitForRecording(result);

    // Update keywords mid-recording
    rerender({ keywords: "updated-keywords" });

    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("idle");
    });

    // The updated keywords should have been used
    expect(mockTranscribeAudio).toHaveBeenCalledWith(
      expect.any(Blob),
      "updated-keywords",
    );
  });

  // ─── Stream track cleanup in onstop ─────────────────────────────────

  it("stops media stream tracks in the onstop handler", async () => {
    // When recording stops normally (not cancel), the onstop handler should
    // stop all tracks on the original media stream
    mockTranscribeAudio.mockResolvedValue({ text: "done" });

    const { result } = renderHook(() =>
      useAudioRecorder({ onTranscript: vi.fn(), onError: vi.fn() }),
    );

    await startAndWaitForRecording(result);

    await act(async () => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.state).toBe("idle");
    });

    // Track stop should have been called in the onstop handler
    expect(mockStream._mockTrack.stop).toHaveBeenCalled();
  });
});

import { isCaptionMode, type CaptionMode } from "../server/types.ts";
const DATABASE_NAME = "lecture-note-recorder";
const DATABASE_VERSION = 1;
const STORE_NAME = "audio-packets";
const PACKET_BYTES = 32_000; // 1 second of 16 kHz mono signed 16-bit PCM.
const MAX_IN_FLIGHT = 24;
const MAX_SOCKET_BUFFER = 1_000_000;

export type RecorderConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "stopping" | "error";

interface StoredPacket {
  id: string;
  lectureId: string;
  sessionId: string;
  sequence: number;
  pcm: ArrayBuffer;
  durationMs: number;
  createdAt: number;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("브라우저 로컬 저장소 요청이 실패했습니다."));
  });
}

async function openPacketDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) throw new Error("이 브라우저는 녹음 복구용 IndexedDB를 지원하지 않습니다.");
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
    store.createIndex("lecture-created", ["lectureId", "createdAt"], { unique: false });
  };
  return requestResult(request);
}

function completeTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("녹음 버퍼 저장에 실패했습니다."));
    transaction.onabort = () => reject(transaction.error || new Error("녹음 버퍼 저장이 중단되었습니다."));
  });
}

function writableTransaction(database: IDBDatabase): IDBTransaction {
  try { return database.transaction(STORE_NAME, "readwrite", { durability: "strict" }); }
  catch { return database.transaction(STORE_NAME, "readwrite"); }
}

async function putPacket(database: IDBDatabase, packet: StoredPacket): Promise<void> {
  const transaction = writableTransaction(database);
  transaction.objectStore(STORE_NAME).put(packet);
  await completeTransaction(transaction);
}

async function deletePacket(database: IDBDatabase, packetId: string): Promise<void> {
  const transaction = writableTransaction(database);
  transaction.objectStore(STORE_NAME).delete(packetId);
  await completeTransaction(transaction);
}

async function queuedPackets(database: IDBDatabase, lectureId: string, excluded: Set<string>, limit: number): Promise<StoredPacket[]> {
  const transaction = database.transaction(STORE_NAME, "readonly");
  const index = transaction.objectStore(STORE_NAME).index("lecture-created");
  const range = IDBKeyRange.bound([lectureId, 0], [lectureId, Number.MAX_SAFE_INTEGER]);
  const packets: StoredPacket[] = [];
  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(range, "next");
    request.onerror = () => reject(request.error || new Error("녹음 버퍼를 읽지 못했습니다."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || packets.length >= limit) return resolve();
      const packet = cursor.value as StoredPacket;
      if (!excluded.has(packet.id)) packets.push(packet);
      cursor.continue();
    };
  });
  return packets;
}

async function queuedDuration(database: IDBDatabase, lectureId: string): Promise<number> {
  const transaction = database.transaction(STORE_NAME, "readonly");
  const index = transaction.objectStore(STORE_NAME).index("lecture-created");
  const range = IDBKeyRange.bound([lectureId, 0], [lectureId, Number.MAX_SAFE_INTEGER]);
  let duration = 0;
  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(range, "next");
    request.onerror = () => reject(request.error || new Error("녹음 버퍼를 확인하지 못했습니다."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      duration += Number((cursor.value as StoredPacket).durationMs || 0);
      cursor.continue();
    };
  });
  return duration;
}

/** Audio captured in this browser that the server has not acknowledged yet. */
export async function bufferedAudioMs(lectureId: string): Promise<number> {
  const database = await openPacketDatabase();
  try { return await queuedDuration(database, lectureId); } finally { database.close(); }
}

export async function discardBufferedAudio(lectureId: string): Promise<void> {
  const database = await openPacketDatabase();
  try {
    const transaction = writableTransaction(database);
    const index = transaction.objectStore(STORE_NAME).index("lecture-created");
    const range = IDBKeyRange.bound([lectureId, 0], [lectureId, Number.MAX_SAFE_INTEGER]);
    index.openCursor(range).onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    await completeTransaction(transaction);
  } finally {
    database.close();
  }
}

/** Binary protocol: LN01 + uint16 session id byte length + uint32 sequence + session id + PCM. */
export function encodeAudioPacket(packet: Pick<StoredPacket, "sessionId" | "sequence" | "pcm">): ArrayBuffer {
  const session = new TextEncoder().encode(packet.sessionId);
  const output = new Uint8Array(10 + session.byteLength + packet.pcm.byteLength);
  output.set([0x4c, 0x4e, 0x30, 0x31], 0);
  const view = new DataView(output.buffer);
  view.setUint16(4, session.byteLength, false);
  view.setUint32(6, packet.sequence, false);
  output.set(session, 10);
  output.set(new Uint8Array(packet.pcm), 10 + session.byteLength);
  return output.buffer;
}

export interface CaptureOptions {
  /** '' = system default microphone, 'off' = do not record the microphone. */
  micDeviceId: string;
  /** Also record a shared browser tab or screen's audio (online meetings). */
  includeShared: boolean;
}

function micConstraints(deviceId: string, includeShared: boolean): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: 1,
    // A shared call plays through the speakers, so cancel echo then; in a room keep the raw voices.
    echoCancellation: includeShared,
    noiseSuppression: true,
    autoGainControl: true
  };
}

export async function openMicrophone(deviceId: string, includeShared = false): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId, includeShared), video: false });
  } catch (error) {
    if (!(error instanceof DOMException) || !["OverconstrainedError", "NotSupportedError"].includes(error.name)) throw error;
    return navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId } : true, video: false });
  }
}

/** Asks the browser to share a tab/screen with audio. Chrome·Edge: tick “Share tab audio” / “Share system audio”. */
export async function openSharedAudio(): Promise<MediaStream> {
  if (!navigator.mediaDevices.getDisplayMedia) throw new Error("이 브라우저는 화면 소리 공유를 지원하지 않습니다. Chrome 또는 Edge를 사용하세요.");
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // Chrome-only hints; other browsers ignore them.
    systemAudio: "include", selfBrowserSurface: "exclude", preferCurrentTab: false
  } as DisplayMediaStreamOptions);
  // Video is only needed to obtain the audio permission; it is never recorded.
  stream.getVideoTracks().forEach((track) => track.stop());
  if (!stream.getAudioTracks().length) {
    throw new Error("공유한 화면에 소리가 없습니다. 공유 창에서 ‘탭 오디오 공유’ 또는 ‘시스템 오디오 공유’를 켜고 다시 시도하세요.");
  }
  return stream;
}

function levelReader(context: AudioContext, source: AudioNode): () => number {
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  return () => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += value * value;
    return Math.sqrt(sum / data.length);
  };
}

/** Sound check: meters only, nothing is sent or saved. */
export class InputPreview {
  private context?: AudioContext;
  private streams: MediaStream[] = [];
  private timer?: number;
  onLevels: (mic: number, shared: number) => void = () => {};
  onWarning: (message: string) => void = () => {};

  async start(options: CaptureOptions): Promise<void> {
    await this.stop();
    try {
      this.context = new AudioContext();
      const readers: { mic?: () => number; shared?: () => number } = {};
      if (options.micDeviceId !== "off") {
        const mic = await openMicrophone(options.micDeviceId, options.includeShared);
        this.streams.push(mic);
        readers.mic = levelReader(this.context, this.context.createMediaStreamSource(mic));
      }
      if (options.includeShared) {
        const shared = await openSharedAudio();
        this.streams.push(shared);
        readers.shared = levelReader(this.context, this.context.createMediaStreamSource(shared));
        shared.getAudioTracks()[0]?.addEventListener("ended", () => this.onWarning("화면 공유가 끝나 상대방 소리가 끊겼습니다."));
      }
      await this.context.resume();
      this.timer = window.setInterval(() => this.onLevels(readers.mic?.() || 0, readers.shared?.() || 0), 90);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    window.clearInterval(this.timer);
    this.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    this.streams = [];
    if (this.context && this.context.state !== "closed") await this.context.close().catch(() => {});
    this.context = undefined;
    this.onLevels(0, 0);
  }

  get active(): boolean { return Boolean(this.context); }
}

export class LectureRecorder {
  private context?: AudioContext;
  private streams: MediaStream[] = [];
  private socket?: WebSocket;
  private sources: MediaStreamAudioSourceNode[] = [];
  private levelTimer?: number;
  private worklet?: AudioWorkletNode;
  private gain?: GainNode;
  private database?: IDBDatabase;
  private lectureId?: string;
  private sessionId = "";
  private sequence = 0;
  private packetParts: Uint8Array[] = [];
  private packetByteLength = 0;
  private persistChain: Promise<void> = Promise.resolve();
  private inFlight = new Map<string, StoredPacket>();
  private draining = false;
  private stopping = false;
  private drainDuringStop = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: number;
  private ackTimer?: number;
  private serverReady = false;
  private lastServerError = "";
  private lastLevelAt = 0;
  private levelSampleStartedAt = 0;
  private levelSampleSum = 0;
  private levelSampleCount = 0;
  private lowLevelWarned = false;
  private warnedDisconnected = false;
  private queuedMs = 0;
  private releaseBrowserLock?: () => void;
  private fallbackLockTimer?: number;
  private readonly instanceId = crypto.randomUUID();

  onLevel: (level: number) => void = () => {};
  onLevels: (mic: number, shared: number) => void = () => {};
  onConnection: (state: RecorderConnectionState) => void = () => {};
  onWarning: (message: string) => void = () => {};
  onFatal: (message: string) => void = () => {};
  onBuffered: (milliseconds: number) => void = () => {};
  onCaptionMode: (mode: CaptionMode) => void = () => {};
  onTranslationDelta: (delta: string) => void = () => {};
  onTranscriptPartial: (text: string) => void = () => {};
  onTranscriptCommitted: (text: string) => void = () => {};
  onTranscriptStatus: (status: string, message?: string) => void = () => {};

  /** `options: null` uploads the browser backlog without opening any input. */
  async start(lectureId: string, options: CaptureOptions | null = { micDeviceId: "", includeShared: false }): Promise<void> {
    if (this.active) {
      if (this.lectureId === lectureId) {
        this.forceReconnect();
        return;
      }
      throw new Error("다른 회의를 녹음하고 있습니다. 현재 녹음을 일시정지한 뒤 전환하세요.");
    }

    this.stopping = false;
    this.lectureId = lectureId;
    this.sessionId = crypto.randomUUID();
    this.sequence = 0;
    this.warnedDisconnected = false;
    try {
      await this.acquireBrowserLock();
      // Capture first: the screen-share prompt must follow the click closely.
      if (options) await this.startCapture(options);
      this.database = await openPacketDatabase();
      this.queuedMs = await queuedDuration(this.database, lectureId);
      this.onBuffered(this.queuedMs);
      void navigator.storage?.persist?.().catch(() => false);
      this.connectSocket();
    } catch (error) {
      await this.teardown();
      throw error;
    }
  }

  private async startCapture(options: CaptureOptions): Promise<void> {
    if (options.micDeviceId === "off" && !options.includeShared) throw new Error("녹음할 소리를 하나 이상 선택하세요.");
    if (options.micDeviceId !== "off") this.streams.push(await openMicrophone(options.micDeviceId, options.includeShared));
    if (options.includeShared) {
      const shared = await openSharedAudio();
      this.streams.push(shared);
      shared.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (!this.stopping) this.onWarning("화면 공유가 끝나 상대방 소리는 더 이상 녹음되지 않습니다. 마이크 녹음은 계속됩니다.");
      });
    }
    this.context = new AudioContext({ latencyHint: "interactive" });
    await this.context.audioWorklet.addModule("/audio-worklet.js");
    // Every source feeds one mono worklet input; Web Audio sums the connections.
    this.worklet = new AudioWorkletNode(this.context, "lecture-pcm-processor", {
      channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers"
    });
    this.gain = this.context.createGain();
    this.gain.gain.value = 0;
    this.worklet.port.onmessage = (event) => {
      if (event.data?.type !== "audio" || this.stopping) return;
      const now = performance.now();
      const rms = Number(event.data.rms || 0);
      if (!this.levelSampleStartedAt) this.levelSampleStartedAt = now;
      if (rms > 0.0005) { this.levelSampleSum += rms; this.levelSampleCount += 1; }
      if (now - this.levelSampleStartedAt >= 30_000) {
        const average = this.levelSampleCount ? this.levelSampleSum / this.levelSampleCount : 0;
        if (!this.lowLevelWarned && this.levelSampleCount > 100 && average < 0.025) {
          this.lowLevelWarned = true;
          this.onWarning("입력이 30초 이상 매우 작습니다. 마이크를 테이블 가운데로 옮기거나 입력 음량을 높여 주세요.");
        }
        this.levelSampleStartedAt = now; this.levelSampleSum = 0; this.levelSampleCount = 0;
      }
      if (now - this.lastLevelAt >= 80) {
        this.lastLevelAt = now;
        this.onLevel(Math.min(1, rms * 5));
      }
      this.addPcm(new Uint8Array(event.data.buffer as ArrayBuffer));
    };
    const readers: Array<() => number> = [];
    for (const stream of this.streams) {
      const source = this.context.createMediaStreamSource(stream);
      source.connect(this.worklet);
      this.sources.push(source);
      readers.push(levelReader(this.context, source));
    }
    this.worklet.connect(this.gain).connect(this.context.destination);
    const micIndex = options.micDeviceId === "off" ? -1 : 0;
    const sharedIndex = options.includeShared ? this.streams.length - 1 : -1;
    this.levelTimer = window.setInterval(() => this.onLevels(readers[micIndex]?.() || 0, readers[sharedIndex]?.() || 0), 90);
    await this.context.resume();
  }

  private addPcm(bytes: Uint8Array): void {
    this.packetParts.push(bytes);
    this.packetByteLength += bytes.byteLength;
    if (this.packetByteLength >= PACKET_BYTES) this.flushPacket();
  }

  private flushPacket(): void {
    if (!this.packetByteLength || !this.lectureId || !this.database) return;
    const byteLength = this.packetByteLength;
    const pcm = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of this.packetParts) { pcm.set(part, offset); offset += part.byteLength; }
    this.packetParts = [];
    this.packetByteLength = 0;
    this.levelSampleStartedAt = 0;
    this.levelSampleSum = 0;
    this.levelSampleCount = 0;
    this.lowLevelWarned = false;
    const packet: StoredPacket = {
      id: `${this.lectureId}:${this.sessionId}:${this.sequence}`,
      lectureId: this.lectureId,
      sessionId: this.sessionId,
      sequence: this.sequence++,
      pcm: pcm.buffer,
      durationMs: byteLength / 32,
      createdAt: Date.now()
    };
    this.persistChain = this.persistChain.then(async () => {
      try {
        await putPacket(this.database!, packet);
        this.queuedMs += packet.durationMs;
        this.onBuffered(this.queuedMs);
        void this.drain();
      } catch (error) {
        const quota = error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED");
        const message = quota
          ? "브라우저 녹음 버퍼의 저장 공간이 부족해 마이크를 중지했습니다. 디스크 공간을 확보한 뒤 다시 연결하세요."
          : `브라우저 녹음 버퍼 저장 실패로 마이크를 중지했습니다: ${error instanceof Error ? error.message : String(error)}`;
        await this.fail(message, false);
      }
    });
  }

  private connectSocket(): void {
    if (this.stopping || !this.lectureId || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    window.clearTimeout(this.reconnectTimer);
    this.onConnection(this.reconnectAttempts ? "reconnecting" : "connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/audio/${this.lectureId}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.serverReady = false;
    this.lastServerError = "";
    socket.onopen = () => {
      if (this.socket !== socket || this.stopping) return;
      this.reconnectAttempts = 0;
      socket.send(JSON.stringify({ type: "hello", sessionId: this.sessionId, liveFromSequence: this.sequence }));
    };
    socket.onmessage = (event) => { void this.handleMessage(event.data); };
    socket.onerror = () => {
      // onclose owns retry scheduling so the user receives one stable state change.
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.serverReady = false;
      this.inFlight.clear();
      window.clearTimeout(this.ackTimer);
      if (this.stopping) return;
      if (event.code === 1008) {
        void this.fail(this.lastServerError || `녹음 서버가 연결을 거부했습니다: ${event.reason || "회의 상태 또는 다른 탭의 녹음을 확인하세요."}`);
        return;
      }
      if (!this.warnedDisconnected) {
        this.warnedDisconnected = true;
        this.onWarning("녹음 서버 연결이 끊겼습니다. 마이크 입력은 브라우저에 임시 저장하며 자동으로 다시 연결합니다.");
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    this.onConnection("reconnecting");
    const delay = Math.min(10_000, 750 * (2 ** Math.min(this.reconnectAttempts++, 4)));
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connectSocket(), delay);
  }

  private async handleMessage(data: unknown): Promise<void> {
    let value: any;
    try {
      const text = typeof data === "string" ? data : data instanceof Blob ? await data.text() : new TextDecoder().decode(data as ArrayBuffer);
      value = JSON.parse(text);
    } catch { return; }
    if (value?.type === "ready") {
      this.serverReady = true;
      this.warnedDisconnected = false;
      this.onConnection("connected");
      void this.drain();
      return;
    }
    if (value?.type === "error") {
      this.lastServerError = String(value.error || "녹음 서버 연결 오류가 발생했습니다.");
      return;
    }
    if (value?.type === "caption_mode" && isCaptionMode(value.mode)) {
      this.onCaptionMode(value.mode);
      return;
    }
    if (value?.type === "translation_delta" && typeof value.text === "string") {
      this.onTranslationDelta(value.text);
      return;
    }
    if (value?.type === "transcript_partial" && typeof value.text === "string") {
      this.onTranscriptPartial(value.text);
      return;
    }
    if (value?.type === "transcript_committed") {
      this.onTranscriptPartial("");
      this.onTranscriptCommitted(typeof value.text === "string" ? value.text : "");
      return;
    }
    if (value?.type === "transcript_status" && typeof value.status === "string") {
      this.onTranscriptStatus(value.status, typeof value.message === "string" ? value.message : undefined);
      return;
    }
    if (value?.type !== "ack" || typeof value.sessionId !== "string" || !Number.isInteger(value.sequence)) return;
    const key = `${this.lectureId}:${value.sessionId}:${value.sequence}`;
    const packet = this.inFlight.get(key);
    if (!packet || !this.database) return;
    this.inFlight.delete(key);
    try {
      await deletePacket(this.database, key);
      this.queuedMs = Math.max(0, this.queuedMs - packet.durationMs);
      this.onBuffered(this.queuedMs);
    } catch (error) {
      this.onWarning(`서버 전송 확인 후 브라우저 버퍼 정리에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.database || !this.lectureId || !this.serverReady || this.socket?.readyState !== WebSocket.OPEN) return;
    this.draining = true;
    try {
      while ((!this.stopping || this.drainDuringStop) && this.serverReady && this.socket?.readyState === WebSocket.OPEN && this.inFlight.size < MAX_IN_FLIGHT && this.socket.bufferedAmount < MAX_SOCKET_BUFFER) {
        const packets = await queuedPackets(this.database, this.lectureId, new Set(this.inFlight.keys()), MAX_IN_FLIGHT - this.inFlight.size);
        if (!packets.length) break;
        for (const packet of packets) {
          if (this.socket?.readyState !== WebSocket.OPEN) break;
          this.inFlight.set(packet.id, packet);
          this.socket.send(encodeAudioPacket(packet));
        }
      }
      if (this.inFlight.size) this.armAckTimeout();
    } catch (error) {
      this.onWarning(`저장된 녹음 전송에 실패했습니다. 자동으로 재시도합니다: ${error instanceof Error ? error.message : String(error)}`);
      this.socket?.close(1011, "packet drain failed");
    } finally {
      this.draining = false;
    }
  }

  private armAckTimeout(): void {
    window.clearTimeout(this.ackTimer);
    this.ackTimer = window.setTimeout(() => {
      if (!this.stopping && this.inFlight.size && this.socket?.readyState === WebSocket.OPEN) {
        this.onWarning("녹음 서버의 저장 확인이 지연되어 연결을 다시 시도합니다. 확인되지 않은 음성은 브라우저에 유지됩니다.");
        this.socket.close(4000, "ack timeout");
      }
    }, 15_000);
  }

  /** Sends every buffered packet for this meeting, then stops. Returns what is still unsent. */
  async flushOnly(lectureId: string, timeoutMs = 120_000): Promise<number> {
    await this.start(lectureId, null);
    const deadline = Date.now() + timeoutMs;
    while (this.queuedMs > 0 && Date.now() < deadline) await new Promise((resolve) => window.setTimeout(resolve, 200));
    await this.stop();
    return this.queuedMs;
  }

  forceReconnect(): void {
    if (!this.active || this.stopping) return;
    if (this.socket?.readyState === WebSocket.OPEN) void this.drain();
    else {
      this.socket?.close();
      this.socket = undefined;
      this.reconnectAttempts = 0;
      this.connectSocket();
    }
  }

  async stop(): Promise<void> {
    if (!this.active && !this.lectureId) return;
    this.stopping = true;
    this.drainDuringStop = true;
    this.onConnection("stopping");
    this.flushPacket();
    await this.persistChain.catch(() => {});
    await this.drain();
    const deadline = Date.now() + 5000;
    while (this.queuedMs > 0 && this.socket?.readyState === WebSocket.OPEN && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    this.drainDuringStop = false;
    await this.teardown();
    this.onConnection("idle");
  }

  private async fail(message: string, flush = true): Promise<void> {
    if (this.stopping) return;
    this.onConnection("error");
    this.onFatal(message);
    if (flush) {
      this.flushPacket();
      await this.persistChain.catch(() => {});
    }
    this.stopping = true;
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.ackTimer);
    window.clearInterval(this.levelTimer);
    this.worklet?.disconnect();
    this.sources.forEach((source) => source.disconnect());
    this.gain?.disconnect();
    this.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    if (this.context && this.context.state !== "closed") await this.context.close().catch(() => {});
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, "stopped");
    this.database?.close();
    this.context = undefined;
    this.streams = [];
    this.socket = undefined;
    this.sources = [];
    this.worklet = undefined;
    this.gain = undefined;
    this.database = undefined;
    this.serverReady = false;
    this.drainDuringStop = false;
    this.inFlight.clear();
    this.packetParts = [];
    this.packetByteLength = 0;
    this.lectureId = undefined;
    this.sessionId = "";
    // queuedMs deliberately survives teardown: unacknowledged packets remain in
    // IndexedDB and the UI must keep showing that recovery backlog.
    this.onLevel(0);
    this.onLevels(0, 0);
    this.releaseLock();
  }

  private async acquireBrowserLock(): Promise<void> {
    if (navigator.locks?.request) {
      let settle!: (acquired: boolean) => void;
      const acquired = new Promise<boolean>((resolve) => { settle = resolve; });
      void navigator.locks.request("lecture-note-audio-capture", { ifAvailable: true }, async (lock) => {
        if (!lock) { settle(false); return; }
        settle(true);
        await new Promise<void>((resolve) => { this.releaseBrowserLock = resolve; });
      }).catch(() => settle(false));
      if (!await acquired) throw new Error("다른 탭에서 이미 마이크 녹음 중입니다. 해당 탭에서 먼저 일시정지하세요.");
      return;
    }
    const key = "lecture-note-recorder-lock";
    const readLock = () => {
      try { return JSON.parse(localStorage.getItem(key) || "null") as { owner?: string; expiresAt?: number } | null; }
      catch { return null; }
    };
    const existing = readLock();
    if (existing?.owner && existing.owner !== this.instanceId && Number(existing.expiresAt) > Date.now()) {
      throw new Error("다른 탭에서 이미 마이크 녹음 중입니다. 해당 탭에서 먼저 일시정지하세요.");
    }
    const refresh = () => localStorage.setItem(key, JSON.stringify({ owner: this.instanceId, expiresAt: Date.now() + 5000 }));
    refresh();
    if (readLock()?.owner !== this.instanceId) throw new Error("다른 탭에서 이미 마이크 녹음 중입니다.");
    this.fallbackLockTimer = window.setInterval(refresh, 2000);
    this.releaseBrowserLock = () => {
      window.clearInterval(this.fallbackLockTimer);
      if (readLock()?.owner === this.instanceId) localStorage.removeItem(key);
    };
  }

  private releaseLock(): void {
    this.releaseBrowserLock?.();
    this.releaseBrowserLock = undefined;
    window.clearInterval(this.fallbackLockTimer);
  }

  get active(): boolean { return Boolean(this.context && this.context.state !== "closed"); }
  get activeLectureId(): string | undefined { return this.lectureId; }
  get bufferedMs(): number { return this.queuedMs; }
}

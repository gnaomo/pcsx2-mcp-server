/**
 * PCSX2 Debug Server Client
 * Talks to the custom C++ JSON/TCP server inside PCSX2 (port 21512)
 * 
 * This REPLACES the GDB client — gives us EVERYTHING:
 *   - Full 128-bit registers (all 7 categories)
 *   - Native PCSX2 disassembly
 *   - Expression evaluation with symbol lookup
 *   - Conditional breakpoints
 *   - Memory watchpoints (read/write/onChange)
 *   - Step and step-over (delay slot aware)
 *   - Thread list, module list
 *   - String reading, address validation
 * 
 * Protocol: newline-delimited JSON over TCP
 * Request:  {"cmd":"...", ...}\n
 * Response: {"ok":true, ...}\n
 */

import * as net from 'node:net';

export interface DebugRegister {
  name: string;
  value: string;  // 32-char hex string (128-bit)
  display: string; // PCSX2's formatted display
}

export interface RegisterCategory {
  size: number;  // bits per register
  count: number;
  regs: DebugRegister[];
}


export interface DisasmInstruction {
  address: string;
  opcode: string;
  disasm: string;
}

export interface BreakpointInfo {
  address: string;
  enabled: boolean;
  temporary: boolean;
  stepping: boolean;
  has_condition: boolean;
  condition?: string;
  description?: string;
}

export interface MemcheckInfo {
  start: string;
  end: string;
  hits: number;
  last_pc: string;
  last_addr: string;
  description?: string;
}

export interface ThreadInfo {
  id: number;
  pc: string;
  status: number;
  wait_type: number;
}

export interface StepResult {
  old_pc: string;
  new_pc: string;
  disasm: string;
  opcode?: string;
  in_bios: boolean;
  timed_out: boolean;
  paused: boolean;
}

export interface EvalResult {
  ok: boolean;
  result?: number;
  hex?: string;
  error?: string;
}

export interface SymbolLookup {
  found: boolean;
  name?: string;
  address?: string;
  size?: number;
  offset?: number;
}

export interface FunctionInfo {
  found: boolean;
  name?: string;
  address?: string;
  size?: number;
  is_no_return?: boolean;
}

export interface FunctionListEntry {
  name: string;
  address: string;
  size: number;
  original_hash: number;
  current_hash: number;
}

export interface DecodedInstruction {
  address: string;
  opcode: string;
  is_branch: boolean;
  is_conditional: boolean;
  condition_met: boolean;
  branch_target: string;
  is_linked_branch: boolean;
  is_likely_branch: boolean;
  is_branch_to_register: boolean;
  branch_register_num: number;
  is_syscall: boolean;
  is_data_access: boolean;
  data_size: number;
  data_address: string;
  has_relevant_address: boolean;
  relevant_address: string;
}

export type MemValueType = 'u8' | 's8' | 'u16' | 's16' | 'u32' | 's32' | 'u64' | 'float';
export type MemSearchComparison =
  | 'equals' | 'not_equals' | 'greater' | 'less' | 'greater_equal' | 'less_equal'
  | 'changed' | 'unchanged' | 'increased' | 'decreased';

export interface MemSearchResult {
  address: string;
  value: number;
}

export interface GameInfo {
  alive: boolean;
  title?: string;
  serial?: string;
  elf?: string;
  crc?: string;
}

export interface GameDbInfo {
  alive: boolean;
  found: boolean;
  name?: string;
  name_en?: string;
  region?: string;
  compatibility?: string;
  ee_round_mode?: string;
  ee_div_round_mode?: string;
  vu0_round_mode?: string;
  vu1_round_mode?: string;
  ee_clamp_mode?: string;
  vu0_clamp_mode?: string;
  vu1_clamp_mode?: string;
  game_fixes?: string[];
  /** Raw pnach text of PCSX2's own embedded compatibility patch for this
   * exact CRC, if one exists. Often names real addresses directly. */
  gamedb_patch?: string;
}

export interface GamePatchInfo {
  name: string;
  description?: string;
  author?: string;
}

export interface VuInstructionFlags {
  /** I flag: the lower word isn't an opcode - it's a raw f32 immediate
   * (see `lower` below, formatted as "LOI <float> (<hex>)"), latched into
   * VI[REG_I] on real hardware. */
  i: boolean;
  /** E flag: end of microprogram. Real hardware still executes 2 more
   * instructions after this one (delay-slot-like), it does not halt
   * immediately - don't treat this as "the last useful instruction". */
  e: boolean;
  /** M flag (VU0 only). */
  m: boolean;
  /** D flag: debug/breakpoint interrupt. */
  d: boolean;
  /** T flag: trace interrupt. */
  t: boolean;
}

export interface VuInstruction {
  address: string;
  upper_opcode: string;
  lower_opcode: string;
  flags: VuInstructionFlags;
  /** Disassembled upper-pipeline op (always a real instruction). */
  upper: string;
  /** Disassembled lower-pipeline op, OR - when flags.i is set - the decoded
   * float immediate as "LOI <value> (<hex>)" instead of a disassembly,
   * since the lower word isn't an opcode in that case. */
  lower: string;
}

export interface VuBreakpointInfo {
  vu: 0 | 1;
  address: string;
  description?: string;
}

export interface MemReadRequest {
  address: string;
  length: number;
}

export interface MemReadResult {
  address: string;
  length: number;
  hex: string;
  allValid: boolean;
}

type CpuTarget = 'ee' | 'iop';

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  /**
   * Set once this request's client-side timeout has fired. The queue slot
   * is kept (not removed) so that if the server's reply arrives later, it
   * gets consumed and discarded right here instead of being handed to a
   * later, unrelated command's promise (the FIFO queue is what makes that
   * matching possible in the first place - see processBuffer()).
   */
  timedOut: boolean;
  cmdName: string;
}

export class DebugServerClient {
  private host: string;
  private port: number;
  private socket: net.Socket | null = null;
  private connected = false;
  private responseBuffer = '';
  /**
   * Requests are sent and answered strictly in order (one line in, one
   * line out), so a FIFO queue - rather than a single pending resolver -
   * is what lets us correctly pair each reply with the request that
   * caused it, even when timeouts or bursts of buffered data are involved.
   */
  private pendingQueue: PendingRequest[] = [];

  constructor(host = '127.0.0.1', port = 21512) {
    this.host = host;
    this.port = port;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.setEncoding('utf8');

      const timeout = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error(`Connection timeout to DebugServer at ${this.host}:${this.port}`));
      }, 3000);

      this.socket.connect(this.port, this.host, () => {
        clearTimeout(timeout);
        this.connected = true;
        resolve();
      });

      this.socket.on('data', (data: string) => {
        this.responseBuffer += data;
        this.processBuffer();
      });

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        this.connected = false;
        if (this.pendingQueue.length > 0) {
          this.rejectAllPending(err);
        } else {
          reject(err);
        }
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.rejectAllPending(new Error('Connection to PCSX2 Debug Server closed'));
      });
    });
  }

  /** Reject and clear every outstanding request (connection lost, etc). */
  private rejectAllPending(err: Error): void {
    const queue = this.pendingQueue;
    this.pendingQueue = [];
    for (const entry of queue) {
      if (!entry.timedOut) {
        entry.timedOut = true;
        entry.reject(err);
      }
    }
  }

  private processBuffer(): void {
    // Drain every complete line currently buffered, not just one. The
    // server can reply to more than one command's worth of data within a
    // single TCP 'data' event (e.g. after a slow step_over finally
    // resolves while a fast command's reply is also sitting in the
    // socket); stopping after the first line left the rest sitting in
    // the buffer to be misread as the reply to whatever the *next*
    // unrelated command turned out to be.
    let newlineIdx: number;
    while ((newlineIdx = this.responseBuffer.indexOf('\n')) >= 0) {
      const line = this.responseBuffer.substring(0, newlineIdx);
      this.responseBuffer = this.responseBuffer.substring(newlineIdx + 1);
      if (!line.trim()) continue;

      const entry = this.pendingQueue.shift();
      if (!entry) continue; // unsolicited line - nothing to do with it

      if (entry.timedOut) {
        // We already gave up on this one and rejected its promise; this is
        // just the late reply catching up. Drop it here so it can't be
        // mismatched against a later, unrelated request.
        continue;
      }

      try {
        const data = JSON.parse(line);
        entry.resolve(data);
      } catch (e) {
        entry.reject(new Error(`Invalid JSON: ${line}`));
      }
    }
  }

  private async send(cmd: Record<string, any>): Promise<any> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to PCSX2 Debug Server');
    }

    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject, timedOut: false, cmdName: cmd.cmd };
      this.pendingQueue.push(entry);

      const json = JSON.stringify(cmd) + '\n';
      this.socket!.write(json);

      // step/step_over can legitimately block on the server for up to ~10s
      // while waiting for a breakpoint to hit, so their client-side timeout
      // needs real headroom above that - otherwise this timeout and the
      // server's own internal one race each other on almost every slow
      // step, which is what fed the stale-reply bug this queue now guards
      // against. A timeout here doesn't cancel the in-flight server-side
      // work, it just gives up on waiting for it (entry.timedOut above is
      // what makes that safe to do).
      // Each of these can legitimately block on the server for a while:
      // step/step_over wait (up to ~5s/~10s server-side) for a breakpoint;
      // frame_advance waits for N frames to actually run (server caps its
      // own wait at 30s); reset_vm/change_disc/save_state_slot/
      // load_state_slot do real disc I/O or full VM reinitialization
      // (observed ~6s even in the simple case). Client timeouts here need
      // real headroom above the server's own worst case, or this client
      // times out on perfectly healthy, still-in-progress commands.
      const slowCommandTimeouts: Record<string, number> = {
        step: 8000,
        step_over: 15000,
        resume_and_wait: 65000,
        frame_advance: 35000,
        reset_vm: 20000,
        change_disc: 20000,
        save_state_slot: 20000,
        load_state_slot: 20000,
        // GPU readback + PNG/JPEG/WebP encode, potentially at a large
        // upscaled internal resolution - give it real headroom over the
        // 5s default rather than racing a legitimately slow encode.
        get_screenshot: 15000,
      };
      const timeoutMs = slowCommandTimeouts[cmd.cmd] ?? 5000;
      setTimeout(() => {
        if (entry.timedOut) return;
        entry.timedOut = true;
        reject(new Error(`Command timeout: ${cmd.cmd}`));
      }, timeoutMs);
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.rejectAllPending(new Error('Disconnected from PCSX2 Debug Server'));
  }

  isConnected(): boolean { return this.connected; }

  // ===== Status =====

  async getStatus(cpu: CpuTarget = 'ee'): Promise<{ alive: boolean; paused: boolean; pc: string; cycles: number }> {
    const resp = await this.send({ cmd: 'status', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.data;
  }

  // ===== Registers =====

  /** Read all registers (all categories or specific one) */
  async readRegisters(cpu: CpuTarget = 'ee', category?: number): Promise<any> {
    const cmd: any = { cmd: 'read_registers', cpu };
    if (category !== undefined) cmd.category = category;
    const resp = await this.send(cmd);
    if (!resp.ok) throw new Error(resp.error);
    return resp.data;
  }

  /** VU1 registers (VF float + VI integer). Not reachable via readRegisters/
   * category - VU1 isn't part of DebugInterface's category contract the way
   * VU0/GS are (those are already available as read_registers categories
   * 4/5/6), so this is a separate command entirely. */
  async readVU1Registers(): Promise<any> {
    const resp = await this.send({ cmd: 'read_vu1_registers' });
    if (!resp.ok) throw new Error(resp.error);
    return resp.data;
  }

  // ===== VU0/VU1 Microcode =====
  // A VU instruction is two independently-encoded 32-bit ops ("upper"/
  // "lower") issued together every 8 bytes - not MIPS-style. These use
  // PCSX2's own disVU0Micro*/disVU1Micro* disassembler functions server-side.

  /** Raw VU0/VU1 micro-program memory as a hex string. address/length are in
   * bytes, offsets into that VU's micro-mem (VU0: 0-0xFFC, VU1: 0-0x3FF8). */
  async readVUMicroMem(vu: 0 | 1, address = 0, length = 256): Promise<{ hex: string; progSize: number }> {
    const resp = await this.send({ cmd: 'read_vu_micromem', vu, address, length });
    if (!resp.ok) throw new Error(resp.error);
    return { hex: resp.hex, progSize: resp.prog_size };
  }

  /** Disassemble VU0/VU1 microcode starting at a byte address (auto-aligned
   * down to a multiple of 8 - VU instructions are always 8-byte aligned).
   * Does not stop at the first E-flagged instruction: real hardware still
   * executes 2 more instructions after E is set, so trailing entries past
   * what looks like "the end" are very likely intentional, not a bug -
   * check `flags.e` per instruction if you need to detect it yourself. */
  async disassembleVU(vu: 0 | 1, address = 0, count = 20): Promise<VuInstruction[]> {
    const resp = await this.send({ cmd: 'disassemble_vu', vu, address, count });
    if (!resp.ok) throw new Error(resp.error);
    return resp.instructions;
  }

  /** Set a VU-side address breakpoint. IMPORTANT: this only fires while the
   * affected VU is running under PCSX2's *interpreter*, not its default
   * microVU JIT recompiler - unlike the EE/IOP recompilers, microVU has no
   * per-instruction breakpoint bailout mechanism at all. If the response
   * includes a `warning`, that VU is currently on the recompiler and this
   * breakpoint will silently never fire until you disable "Enable VU0/VU1
   * Recompiler" in PCSX2's System > Emulation settings for that VU
   * (interpreted VU is meaningfully slower - only disable it for the VU
   * you're actively investigating). */
  async setVUBreakpoint(vu: 0 | 1, address: string | number, description?: string): Promise<{ warning?: string }> {
    const resp = await this.send({ cmd: 'set_vu_breakpoint', vu, address, description });
    if (!resp.ok) throw new Error(resp.error);
    return { warning: resp.warning };
  }

  async removeVUBreakpoint(vu: 0 | 1, address: string | number): Promise<void> {
    const resp = await this.send({ cmd: 'remove_vu_breakpoint', vu, address });
    if (!resp.ok) throw new Error(resp.error);
  }

  /** List VU breakpoints. Omit `vu` to list both VU0 and VU1. */
  async listVUBreakpoints(vu?: 0 | 1): Promise<VuBreakpointInfo[]> {
    const resp = await this.send({ cmd: 'list_vu_breakpoints', vu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.breakpoints;
  }

  /** Clear VU breakpoints. Omit `vu` to clear both VU0 and VU1. */
  async clearVUBreakpoints(vu?: 0 | 1): Promise<void> {
    const resp = await this.send({ cmd: 'clear_vu_breakpoints', vu });
    if (!resp.ok) throw new Error(resp.error);
  }

  /** Full GS drawing-context/environment state dump: both drawing contexts
   * (TEX0/CLAMP/ALPHA/TEST/FRAME/ZBUF/etc, with key sub-fields decoded
   * alongside the raw hex) plus environment-level state (PRIM/blend mode/
   * fog color/etc). GS has no programmable microcode to disassemble the
   * way VU does - this is the analogous "what's GS actually doing right
   * now" feature. Marshaled through the GS thread server-side (GS runs on
   * its own dedicated thread, separate from the CPU thread everything else
   * here touches). */
  async getGSContext(): Promise<any> {
    const resp = await this.send({ cmd: 'get_gs_context' });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  /** Capture the currently rendered PS2 frame as an image. Marshaled through
   * the GS thread server-side (same as getGSContext - the pixel readback
   * touches the GPU device, which only the GS thread owns), then encoded to
   * PNG/JPEG/WebP entirely in memory (no temp files on the PCSX2 side) and
   * returned as base64. width/height=0 means "native GS render resolution",
   * not a particular window size - there's no window involved, this is an
   * off-screen readback. */
  async getScreenshot(options?: {
    format?: 'png' | 'jpg' | 'webp';
    quality?: number;
    width?: number;
    height?: number;
    applyAspect?: boolean;
    cropBorders?: boolean;
  }): Promise<{ width: number; height: number; format: string; encodedBytes: number; dataBase64: string }> {
    const resp = await this.send({
      cmd: 'get_screenshot',
      format: options?.format ?? 'png',
      quality: options?.quality,
      width: options?.width ?? 0,
      height: options?.height ?? 0,
      apply_aspect: options?.applyAspect ?? true,
      crop_borders: options?.cropBorders ?? true,
    });
    if (!resp.ok) throw new Error(resp.error);
    return { width: resp.width, height: resp.height, format: resp.format, encodedBytes: resp.encoded_bytes, dataBase64: resp.data_base64 };
  }

  /** Write a 128-bit register */
  async writeRegister(category: number, index: number, value: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'write_register', cpu, category, index, value });
    if (!resp.ok) throw new Error(resp.error);
  }

  /** Set the Program Counter */
  async setPC(value: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'set_pc', cpu, value });
    if (!resp.ok) throw new Error(resp.error);
  }

  // ===== Memory =====

  /** Read memory as hex string */
  async readMemory(address: string, length: number, cpu: CpuTarget = 'ee'): Promise<string> {
    const resp = await this.send({ cmd: 'read_memory', cpu, address, length });
    if (!resp.ok) throw new Error(resp.error);
    return resp.hex;
  }

  /** Read memory as Buffer */
  async readMemoryBuffer(address: string, length: number, cpu: CpuTarget = 'ee'): Promise<Buffer> {
    const hex = await this.readMemory(address, length, cpu);
    return Buffer.from(hex, 'hex');
  }

  /** Write memory from hex string */
  async writeMemory(address: string, data: string, cpu: CpuTarget = 'ee'): Promise<number> {
    const resp = await this.send({ cmd: 'write_memory', cpu, address, data });
    if (!resp.ok) throw new Error(resp.error);
    return resp.written;
  }

  /** Batch read: one round-trip for many independent {address,length} reads,
   * mirroring the read_multiple_files pattern - use this instead of N
   * sequential readMemory() calls when checking a scattered set of known
   * addresses (e.g. a watch list of struct fields). A bad address in one
   * entry doesn't fail the batch; that entry just comes back with
   * allValid:false. */
  async readMemoryMultiple(reads: MemReadRequest[], cpu: CpuTarget = 'ee'): Promise<MemReadResult[]> {
    const resp = await this.send({ cmd: 'read_memory_multiple', cpu, reads });
    if (!resp.ok) throw new Error(resp.error);
    return resp.results.map((r: any) => ({ address: r.address, length: r.length, hex: r.hex, allValid: r.all_valid }));
  }

  /** Read a null-terminated string */
  async readString(address: string, maxLength = 256, cpu: CpuTarget = 'ee'): Promise<string> {
    const resp = await this.send({ cmd: 'read_string', cpu, address, max_length: maxLength });
    if (!resp.ok) throw new Error(resp.error);
    return resp.string;
  }

  /** Check if an address is valid */
  async isValidAddress(address: string, cpu: CpuTarget = 'ee'): Promise<boolean> {
    const resp = await this.send({ cmd: 'is_valid_address', cpu, address });
    if (!resp.ok) throw new Error(resp.error);
    return resp.valid;
  }

  // ===== Disassembly (NATIVE PCSX2!) =====

  /** Disassemble using PCSX2's own disassembler — perfect output */
  async disassemble(address: string, count = 20, simplify = true, cpu: CpuTarget = 'ee'): Promise<DisasmInstruction[]> {
    const resp = await this.send({ cmd: 'disassemble', cpu, address, count, simplify });
    if (!resp.ok) throw new Error(resp.error);
    return resp.instructions;
  }

  // ===== Expression Evaluation =====

  /** Evaluate a MIPS expression (e.g., "v0 + 0x100", "gp + 0x20") with symbol support */
  async evaluate(expression: string, cpu: CpuTarget = 'ee'): Promise<EvalResult> {
    const resp = await this.send({ cmd: 'evaluate', cpu, expression });
    return resp;
  }

  // ===== Breakpoints =====

  /** Set a breakpoint (optionally with condition expression and description) */
  async setBreakpoint(address: string, options?: { condition?: string; description?: string; temporary?: boolean; cpu?: CpuTarget }): Promise<void> {
    const resp = await this.send({
      cmd: 'set_breakpoint',
      cpu: options?.cpu || 'ee',
      address,
      condition: options?.condition,
      description: options?.description,
      temporary: options?.temporary ?? false,
    });
    if (!resp.ok) throw new Error(resp.error);
  }

  async removeBreakpoint(address: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'remove_breakpoint', cpu, address });
    if (!resp.ok) throw new Error(resp.error);
  }

  async listBreakpoints(cpu: CpuTarget = 'ee'): Promise<BreakpointInfo[]> {
    const resp = await this.send({ cmd: 'list_breakpoints', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.breakpoints;
  }

  // ===== Memory Watchpoints =====

  /** Set a memory watchpoint (read/write/access/onchange) with optional condition */
  async setMemcheck(address: string, end: string, options?: {
    type?: 'read' | 'write' | 'readwrite' | 'onchange';
    action?: 'break' | 'log' | 'both';
    condition?: string;
    description?: string;
    cpu?: CpuTarget;
  }): Promise<void> {
    const resp = await this.send({
      cmd: 'set_memcheck',
      cpu: options?.cpu || 'ee',
      address,
      end,
      type: options?.type || 'write',
      action: options?.action || 'break',
      condition: options?.condition,
      description: options?.description,
    });
    if (!resp.ok) throw new Error(resp.error);
  }

  async removeMemcheck(address: string, end: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'remove_memcheck', cpu, address, end });
    if (!resp.ok) throw new Error(resp.error);
  }

  async listMemchecks(cpu: CpuTarget = 'ee'): Promise<MemcheckInfo[]> {
    const resp = await this.send({ cmd: 'list_memchecks', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.memchecks;
  }

  // ===== Execution Control =====

  async pause(cpu: CpuTarget = 'ee'): Promise<{ pc: string; paused: boolean }> {
    const resp = await this.send({ cmd: 'pause', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return { pc: resp.pc, paused: resp.paused };
  }

  async resume(cpu: CpuTarget = 'ee'): Promise<{ paused: boolean }> {
    const resp = await this.send({ cmd: 'resume', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return { paused: resp.paused };
  }

  /** Resume and block until the VM pauses again (breakpoint/watchpoint hit,
   * or something else paused it) or timeoutMs elapses. Unlike resume(), this
   * closes the gap where a plain resume gives no way to know *when* (or
   * whether) a breakpoint fired short of polling status() in a loop. */
  async resumeAndWait(timeoutMs = 10000, cpu: CpuTarget = 'ee'): Promise<{ pc: string; timedOut: boolean; paused: boolean }> {
    const resp = await this.send({ cmd: 'resume_and_wait', timeout_ms: timeoutMs, cpu });
    if (!resp.ok) throw new Error(resp.error);
    return { pc: resp.pc, timedOut: resp.timed_out, paused: resp.paused };
  }

  /** Single-step one instruction (delay slot aware) */
  async step(cpu: CpuTarget = 'ee'): Promise<StepResult> {
    const resp = await this.send({ cmd: 'step', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  /** Step over a JAL/JALR — effectively "next" */
  async stepOver(cpu: CpuTarget = 'ee'): Promise<StepResult> {
    const resp = await this.send({ cmd: 'step_over', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  // ===== Thread/Module Info =====

  async getThreads(cpu: CpuTarget = 'ee'): Promise<ThreadInfo[]> {
    const resp = await this.send({ cmd: 'get_threads', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.threads;
  }

  async getModules(cpu: CpuTarget = 'iop'): Promise<Array<{ name: string; version: number }>> {
    const resp = await this.send({ cmd: 'get_modules', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.modules;
  }

  /** Get call stack backtrace using PCSX2's MipsStackWalk */
  async getBacktrace(cpu: CpuTarget = 'ee', maxFrames = 32): Promise<Array<{ entry: string; pc: string; sp: string; stack_size: number; disasm: string }>> {
    const resp = await this.send({ cmd: 'get_backtrace', cpu, max_frames: maxFrames });
    if (!resp.ok) throw new Error(resp.error);
    return resp.frames;
  }

  // ===== Bulk Operations =====

  async clearAllBreakpoints(): Promise<void> {
    const resp = await this.send({ cmd: 'clear_breakpoints' });
    if (!resp.ok) throw new Error(resp.error);
  }

  // ===== Symbol Intelligence =====
  // SymbolGuardian keeps its own internal locking on the C++ side and is
  // meaningful even without a booted VM, so these don't require a running
  // game the way most other commands do.

  async resolveAddress(address: string, cpu: CpuTarget = 'ee'): Promise<SymbolLookup> {
    const resp = await this.send({ cmd: 'resolve_address', address, cpu });
    if (!resp.ok) throw new Error(resp.error);
    return { found: resp.found, name: resp.name, address: resp.symbol_address, size: resp.size, offset: resp.offset };
  }

  async findSymbol(name: string, cpu: CpuTarget = 'ee'): Promise<SymbolLookup> {
    const resp = await this.send({ cmd: 'find_symbol', name, cpu });
    if (!resp.ok) throw new Error(resp.error);
    return { found: resp.found, address: resp.address, size: resp.size };
  }

  async getFunctionInfo(address: string, cpu: CpuTarget = 'ee'): Promise<FunctionInfo> {
    const resp = await this.send({ cmd: 'get_function_info', address, cpu });
    if (!resp.ok) throw new Error(resp.error);
    return { found: resp.found, name: resp.name, address: resp.address, size: resp.size, is_no_return: resp.is_no_return };
  }

  /** List known functions, optionally restricted to an address range. Symbols
   * only exist for functions covered by loaded debug info, or ones found by
   * scanFunctions() - retail games with no debug info may return very few. */
  async listFunctions(options?: { start?: string; end?: string; limit?: number; cpu?: CpuTarget }): Promise<{ total_count: number; functions: FunctionListEntry[] }> {
    const resp = await this.send({
      cmd: 'list_functions',
      start: options?.start,
      end: options?.end,
      limit: options?.limit,
      cpu: options?.cpu ?? 'ee',
    });
    if (!resp.ok) throw new Error(resp.error);
    return { total_count: resp.total_count, functions: resp.functions };
  }

  // ===== Code Analysis =====

  /** Structured decode of one instruction: branch target, whether a
   * conditional branch is currently taken, data-access address, etc. -
   * everything MIPSAnalyst already knows without re-deriving it from the
   * disasm string. */
  async decodeInstruction(address: string, cpu: CpuTarget = 'ee'): Promise<DecodedInstruction> {
    const resp = await this.send({ cmd: 'decode_instruction', address, cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  /** Assemble one MIPS instruction from text (e.g. "addiu a0, a0, 4") into its
   * encoded opcode. Pair with writeMemory() to patch code live. */
  async assemble(address: string, instruction: string, cpu: CpuTarget = 'ee'): Promise<string> {
    const resp = await this.send({ cmd: 'assemble', address, instruction, cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.opcode;
  }

  /** Heuristically detect function boundaries in a range with no debug info,
   * adding them to the symbol database (visible afterward via listFunctions/
   * resolveAddress). */
  async scanFunctions(start: string, end: string, options?: { generateHashes?: boolean; cpu?: CpuTarget }): Promise<{ functions_before: number; functions_after: number; functions_added: number }> {
    const resp = await this.send({
      cmd: 'scan_functions',
      start,
      end,
      generate_hashes: options?.generateHashes ?? true,
      cpu: options?.cpu ?? 'ee',
    });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  // ===== Memory Search (Cheat-Engine-style value scanner) =====

  /** Start a new scan over [start, end), keeping only addresses matching the
   * given comparison (or all addresses if comparison is omitted). */
  async searchMemoryStart(options: {
    start: string;
    end?: string;
    type?: MemValueType;
    comparison?: MemSearchComparison;
    value?: number;
    cpu?: CpuTarget;
  }): Promise<{ type: string; candidateCount: number }> {
    const resp = await this.send({
      cmd: 'search_memory_start',
      start: options.start,
      end: options.end,
      type: options.type,
      comparison: options.comparison,
      value: options.value,
      cpu: options.cpu ?? 'ee',
    });
    if (!resp.ok) throw new Error(resp.error);
    return { type: resp.type, candidateCount: resp.candidate_count };
  }

  /** Narrow the current candidate set by re-checking each address. With no
   * `value`, comparisons like "increased"/"changed" are relative to each
   * candidate's value from the previous scan. */
  async searchMemoryNext(comparison: MemSearchComparison, value?: number): Promise<{ candidateCount: number }> {
    const resp = await this.send({ cmd: 'search_memory_next', comparison, value });
    if (!resp.ok) throw new Error(resp.error);
    return { candidateCount: resp.candidate_count };
  }

  async searchMemoryResults(limit = 50): Promise<{ type: string; candidateCount: number; results: MemSearchResult[] }> {
    const resp = await this.send({ cmd: 'search_memory_results', limit });
    if (!resp.ok) throw new Error(resp.error);
    return { type: resp.type, candidateCount: resp.candidate_count, results: resp.results };
  }

  async searchMemoryReset(): Promise<void> {
    const resp = await this.send({ cmd: 'search_memory_reset' });
    if (!resp.ok) throw new Error(resp.error);
  }

  // ===== VM / Session Control =====

  async getGameInfo(): Promise<GameInfo> {
    const resp = await this.send({ cmd: 'get_game_info' });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  /** Cold-resets the VM (blocked if e.g. a memory card write is in progress).
   * Blocks until the reset has actually completed - if the VM was running
   * (not paused) when called, PCSX2's Reset() only schedules the reset and
   * returns immediately internally, so this waits out that in-between state
   * rather than reporting success prematurely. */
  async resetVM(): Promise<{ paused: boolean }> {
    const resp = await this.send({ cmd: 'reset_vm' });
    if (!resp.ok) throw new Error(resp.error);
    return { paused: resp.paused };
  }

  async frameAdvance(frames = 1): Promise<{ timedOut: boolean; pc: string; paused: boolean }> {
    const resp = await this.send({ cmd: 'frame_advance', frames });
    if (!resp.ok) throw new Error(resp.error);
    return { timedOut: resp.timed_out, pc: resp.pc, paused: resp.paused };
  }

  /** Saving never changes whether the VM is paused/running. */
  async saveStateSlot(slot: number): Promise<{ paused: boolean }> {
    const resp = await this.send({ cmd: 'save_state_slot', slot });
    if (!resp.ok) throw new Error(resp.error);
    return { paused: resp.paused };
  }

  /** Loading does NOT restore the pause state that was active when the state
   * was saved - only CPU/memory/GS state is restored. paused here reflects
   * whatever the VM was doing right before this call, unchanged. */
  async loadStateSlot(slot: number, backup = false): Promise<{ paused: boolean }> {
    const resp = await this.send({ cmd: 'load_state_slot', slot, backup });
    if (!resp.ok) throw new Error(resp.error);
    return { paused: resp.paused };
  }

  async changeDisc(path: string, source: 'iso' | 'disc' | 'nodisc' = 'iso'): Promise<{ paused: boolean }> {
    const resp = await this.send({ cmd: 'change_disc', path, source });
    if (!resp.ok) throw new Error(resp.error);
    return { paused: resp.paused };
  }

  // ===== GameDB / Patch Metadata =====
  // Static per-game data - no requireAlive()/marshaling on the server side,
  // same exception as symbol lookups.

  /** PCSX2's own compatibility metadata for the running game: name/region,
   * compatibility rating, EE/VU0/VU1 rounding & clamp modes (useful context
   * if float results look "off" - could just be a known rounding-mode
   * quirk, not a bug in your analysis), known gameFixes PCSX2 already
   * applies, and - if present - the GameDB's own embedded compatibility
   * patch text for this exact CRC (which often names real addresses). */
  async getGameDbInfo(): Promise<GameDbInfo> {
    const resp = await this.send({ cmd: 'get_gamedb_info' });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  /** Community-authored pnach patches/cheats for the running game
   * (CRC-matched). Name + human description + author only - no raw
   * addresses (unlike getGameDbInfo's embedded patch text) - but
   * descriptions alone often hint at what's interesting and where
   * ("Infinite Health", "Unlock All Levels", ...). */
  async listGamePatches(includeCheats = true): Promise<{ unlabelledCount: number; patches: GamePatchInfo[] }> {
    const resp = await this.send({ cmd: 'list_game_patches', cheats: includeCheats });
    if (!resp.ok) throw new Error(resp.error);
    return { unlabelledCount: resp.unlabelled_count, patches: resp.patches };
  }
}

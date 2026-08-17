#!/usr/bin/env node
/**
 * PCSX2 ULTIMATE MCP Server v2.0
 *
 * 3-tier connection priority:
 *   1. Custom DebugServer (port 21512) — FULL 128-bit, native disasm, expressions, conditional BP
 *   2. Pine IPC (port 28011) — memory R/W, game info, save states (vanilla PCSX2)
 *   3. Standalone — PS2Recomp project tools only
 *
 * 30+ tools across categories:
 *   Connection, Memory, Registers, Disassembly, Expression Eval,
 *   Breakpoints, Watchpoints, Stepping, Threads, Game Info,
 *   Save States, Pattern Search, Memory Diff, PS2Recomp Integration
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DebugServerClient } from './debug-server-client.js';
import { PineClient, EmuStatus } from './pine-client.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ===== State =====
// PCSX2-MCP multi-instance (Phase 1): `debugServer`/`pine` remain the
// currently-ACTIVE instance's clients, exactly as before — every existing
// tool body below still reads/writes these two names unmodified. What's new
// is `instances`, a registry of every connection made via pcsx2_connect,
// keyed by instance_id. Switching the active instance (pcsx2_use_instance)
// just reassigns debugServer/pine to point at a different registry entry.
// This is a deliberately lighter design than threading an `instance` param
// through all 60 tools individually (that's still open — see ROADMAP.md
// Phase 2): it's a "select the instance, then act" model rather than
// "target any instance from any call", but it fully unblocks having two+
// PCSX2 processes connected at once and addressing either one.
interface InstanceEntry {
  id: string;
  debug: DebugServerClient | null;
  pine: PineClient | null;
  debugPort?: number;
  pinePort?: number;
  label?: string;
  // Phase 3: game identity, not just ports. Populated best-effort on
  // connect and refreshed on every pcsx2_list_instances call, so instances
  // can be addressed as "the Ratchet one" instead of by port/opaque id.
  serial?: string;
}
const instances = new Map<string, InstanceEntry>();
let activeInstanceId: string | null = null;

let debugServer: DebugServerClient | null = null;
let pine: PineClient | null = null;
const memSnapshots = new Map<string, { addr: number; data: Buffer }>();
const PS2RECOMP_ROOT = process.env.PS2RECOMP_ROOT || 'E:\\Programmi VARI\\PROGETTI\\PS2Recomp';

// Point the module-level debugServer/pine at a given registry entry, making
// it "active" for every existing tool below.
function activateInstance(id: string): void {
  const entry = instances.get(id);
  if (!entry) throw new Error(`No such instance: "${id}"`);
  activeInstanceId = id;
  debugServer = entry.debug;
  pine = entry.pine;
}

// Phase 3: best-effort game-identity lookup for one registry entry. Tries
// DebugServer's get_game_info first (has serial+CRC), falls back to Pine's
// title/ID commands. Silently leaves label/serial unset if neither is
// connected or no VM/game is loaded yet (e.g. instance just booted to the
// BIOS menu) - this is expected and not an error.
async function identifyInstance(entry: InstanceEntry): Promise<void> {
  try {
    if (entry.debug?.isConnected()) {
      const info = await entry.debug.getGameInfo();
      if (info.alive && info.title) {
        entry.label = info.title;
        entry.serial = info.serial;
        return;
      }
    }
  } catch {
    /* fall through to Pine */
  }
  try {
    if (entry.pine?.isConnected()) {
      const title = await entry.pine.getTitle();
      if (title) {
        entry.label = title;
        try {
          entry.serial = await entry.pine.getID();
        } catch {
          /* title alone is still useful */
        }
      }
    }
  } catch {
    /* leave label/serial unset */
  }
}

// Phase 3: resolve a pcsx2_use_instance query against exact id first (fast
// path, unchanged behavior), then fall back to a case-insensitive substring
// match against id/label/serial across every registered instance - lets you
// say "ratchet" or "SCUS-97199" instead of memorizing which id you picked
// at connect time. Throws with the candidate list if the match is ambiguous.
function resolveInstanceId(query: string): string {
  if (instances.has(query)) return query;
  const q = query.toLowerCase();
  const matches = [...instances.values()].filter(
    (e) =>
      e.id.toLowerCase().includes(q) ||
      (e.label && e.label.toLowerCase().includes(q)) ||
      (e.serial && e.serial.toLowerCase().includes(q)),
  );
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0)
    throw new Error(
      `No instance matching "${query}". Use pcsx2_list_instances to see connected instances (id, and game title/serial if identified).`,
    );
  throw new Error(
    `"${query}" matches multiple instances: ${matches.map((m) => m.id).join(', ')}. Be more specific, or use the exact instance_id.`,
  );
}

// Phase 2: per-tool instance targeting. Every tool below (except the 5
// connection-management ones) now takes an optional `instance_id`. When
// given, resolve it (exact id or fuzzy match, same as pcsx2_use_instance)
// and temporarily point the module-level debugServer/pine at THAT
// instance's clients for the duration of this one call only, then restore
// whatever was active before - so a one-off instance_id override never
// disturbs the persistent "active" instance set via pcsx2_use_instance.
// When instance_id is omitted, this is a no-op and behavior is unchanged
// from before Phase 2 (targets whatever's currently active).
async function withInstance<T>(instanceId: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!instanceId) return fn();
  const resolved = resolveInstanceId(instanceId);
  const entry = instances.get(resolved);
  if (!entry) throw new Error(`No such instance: "${resolved}"`);
  const prevDebug = debugServer,
    prevPine = pine,
    prevActive = activeInstanceId;
  debugServer = entry.debug;
  pine = entry.pine;
  activeInstanceId = resolved; // so error/status messages inside fn() read correctly
  try {
    return await fn();
  } finally {
    debugServer = prevDebug;
    pine = prevPine;
    activeInstanceId = prevActive;
  }
}

// ===== Helpers =====
function parseAddr(s: string): number {
  // parseInt() alone silently ignores trailing garbage ("0x1000xyz" -> 0x1000)
  // and returns NaN for empty/non-hex input, which previously flowed straight
  // through to the server as the literal string "0xNaN" - parsed there as 0,
  // so a bad address silently became a read/write to address 0 instead of
  // surfacing an error. Validate the whole cleaned string is hex digits first.
  const cleaned = s.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error(`Invalid address: "${s}" is not a valid hex address`);
  }
  return parseInt(cleaned, 16);
}

function hexDump(buf: Buffer, base: number): string {
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const addr = (base + i).toString(16).padStart(8, '0');
    const hex: string[] = [];
    let ascii = '';
    for (let j = 0; j < 16; j++) {
      if (i + j < buf.length) {
        hex.push(buf[i + j].toString(16).padStart(2, '0'));
        const c = buf[i + j];
        ascii += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
      } else {
        hex.push('  ');
        ascii += ' ';
      }
    }
    lines.push(`${addr}  ${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}

function hasDebug(): boolean {
  return debugServer?.isConnected() ?? false;
}
function hasPine(): boolean {
  return pine?.isConnected() ?? false;
}

async function readMem(addr: number, len: number): Promise<Buffer> {
  if (hasDebug()) return debugServer!.readMemoryBuffer('0x' + addr.toString(16), len);
  if (hasPine()) return pine!.readMemory(addr, len);
  throw new Error('No connection — use pcsx2_connect first');
}

async function writeMem(addr: number, data: Buffer): Promise<void> {
  if (hasDebug()) {
    await debugServer!.writeMemory('0x' + addr.toString(16), data.toString('hex'));
    return;
  }
  if (hasPine()) {
    await pine!.writeMemory(addr, data);
    return;
  }
  throw new Error('No connection');
}

// ===== MCP Server =====
const server = new McpServer(
  { name: 'pcsx2-ultimate-debugger', version: '2.0.0' },
  { capabilities: { tools: {}, resources: {} } },
);

// ==========================================================
//  TOOL: pcsx2_connect
// ==========================================================
server.tool(
  'pcsx2_connect',
  'Connect to a PCSX2 instance. Tries DebugServer (21512), then Pine (28011). DebugServer gives FULL access (128-bit regs, expressions, conditional BP, native disasm). Pine gives memory + game info. Multi-instance: pass a distinct instance_id + debug_port/pine_port for each running PCSX2 process (each instance needs its own DebugServerPort configured — see ROADMAP.md Phase 0). The newly-connected instance becomes the active one; use pcsx2_use_instance to switch back to another already-connected instance, and pcsx2_list_instances to see them all.',
  {
    debug_port: z.number().default(21512).describe('DebugServer port'),
    pine_port: z.number().default(28011).describe('Pine IPC port'),
    mode: z.enum(['auto', 'debug', 'pine']).default('auto'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Name this connection for later pcsx2_use_instance calls. Defaults to a name derived from the ports, e.g. "debug21512".',
      ),
  },
  async ({ debug_port, pine_port, mode, instance_id }) => {
    const results: string[] = [];
    let newDebug: DebugServerClient | null = null;
    let newPine: PineClient | null = null;

    // Try DebugServer
    if (mode === 'auto' || mode === 'debug') {
      try {
        newDebug = new DebugServerClient('127.0.0.1', debug_port);
        await newDebug.connect();
        const st = await newDebug.getStatus();
        results.push(`✅ DebugServer: connected (PC=0x${st.pc}, paused=${st.paused})`);
        results.push('   → 128-bit registers, native disasm, expressions, conditional BP, step-over, threads');
      } catch (e: any) {
        newDebug = null;
        results.push(`❌ DebugServer (port ${debug_port}): ${e.message}`);
      }
    }
    // Try Pine
    if (mode === 'auto' || mode === 'pine') {
      try {
        newPine = new PineClient('127.0.0.1', pine_port);
        results.push(`   Pine target: ${newPine.describeTarget()}`);
        await newPine.connect();
        const title = await newPine.getTitle();
        results.push(`✅ Pine IPC: connected (${title})`);
      } catch (e: any) {
        newPine = null;
        results.push(`❌ Pine: ${e.message}`);
      }
    }

    if (!newDebug && !newPine) {
      results.push('\n⚠️  No connections. Make sure PCSX2 is running.');
      results.push('For DebugServer: patch PCSX2 with pcsx2-plugin/DebugServer.cpp');
      results.push('For Pine: enable IPC in PCSX2 settings');
      return { content: [{ type: 'text' as const, text: results.join('\n') }] };
    }

    const id = instance_id || `debug${debug_port}`;
    instances.set(id, { id, debug: newDebug, pine: newPine, debugPort: debug_port, pinePort: pine_port });
    activateInstance(id);
    const entry = instances.get(id)!;
    await identifyInstance(entry); // best-effort, never throws
    results.push(
      `\n→ registered as instance "${id}"${entry.label ? ` — "${entry.label}"${entry.serial ? ` (${entry.serial})` : ''}` : ''} and set active (${instances.size} instance(s) connected total)`,
    );
    return { content: [{ type: 'text' as const, text: results.join('\n') }] };
  },
);

// ==========================================================
//  TOOL: pcsx2_list_instances
// ==========================================================
server.tool(
  'pcsx2_list_instances',
  "List every PCSX2 instance connected via pcsx2_connect this session, and which one is currently active (i.e. which one every other tool call targets). Refreshes each instance's game title/serial (Phase 3 identity) before listing, so this reflects the currently-loaded game even if it changed (e.g. disc swap) since connect.",
  {},
  async () => {
    if (instances.size === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No instances connected yet. Use pcsx2_connect (or pcsx2_discover_instances to probe for running ones).',
          },
        ],
      };
    }
    const lines: string[] = [];
    for (const [id, entry] of instances) {
      await identifyInstance(entry); // best-effort refresh, never throws
      const active = id === activeInstanceId ? ' (ACTIVE)' : '';
      const d = entry.debug?.isConnected() ? `debug:${entry.debugPort}` : 'debug: disconnected';
      const p = entry.pine?.isConnected() ? `pine:${entry.pinePort}` : 'pine: disconnected';
      const game = entry.label ? ` — "${entry.label}"${entry.serial ? ` (${entry.serial})` : ''}` : '';
      lines.push(`- ${id}${active} — ${d}, ${p}${game}`);
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ==========================================================
//  TOOL: pcsx2_use_instance
// ==========================================================
server.tool(
  'pcsx2_use_instance',
  'Switch the active instance — every other tool call (registers, memory, breakpoints, etc.) targets whichever instance is active. Accepts an exact instance_id, or (Phase 3) a case-insensitive substring match against the id, game title, or serial of any connected instance - e.g. "ratchet" or "SCUS-97199" work if that instance has been identified (see pcsx2_list_instances). Errors with the candidate list if the substring is ambiguous.',
  {
    instance_id: z
      .string()
      .describe(
        "The instance_id used (or auto-assigned) at pcsx2_connect time, or a substring of a connected instance's id/game title/serial",
      ),
  },
  async ({ instance_id }) => {
    try {
      const resolved = resolveInstanceId(instance_id);
      activateInstance(resolved);
      const entry = instances.get(resolved)!;
      const game = entry.label ? ` ("${entry.label}"${entry.serial ? `, ${entry.serial}` : ''})` : '';
      return { content: [{ type: 'text' as const, text: `Active instance is now "${resolved}"${game}.` }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ==========================================================
//  TOOL: pcsx2_discover_instances (Phase 4: auto-discovery)
// ==========================================================
server.tool(
  'pcsx2_discover_instances',
  "Probe a range of consecutive DebugServer ports and auto pcsx2_connect to every PCSX2 instance found that isn't already registered - use this instead of manual pcsx2_connect calls when you don't know in advance how many instances are running or which ports they're on. Closed/unreachable ports fail near-instantly on localhost (ECONNREFUSED), so scanning a small range is fast; only a port with something non-PCSX2 silently eating the connection would incur the full per-port connect timeout. DebugServer only - does not attempt Pine, since Pine's port has no fixed relationship to DebugServerPort in general (this session's 21512/28011 + 21513/28012 pairing is coincidental, not guaranteed). Use pcsx2_connect with an explicit pine_port afterward if you also want Pine on a discovered instance. Never touches already-connected instances.",
  {
    start_port: z.number().default(21512).describe('First DebugServer port to probe'),
    count: z.number().min(1).max(64).default(8).describe('How many consecutive ports to probe, starting at start_port'),
  },
  async ({ start_port, count }) => {
    const alreadyPorts = new Map<number, string>();
    for (const e of instances.values()) if (e.debugPort !== undefined) alreadyPorts.set(e.debugPort, e.id);

    const found: string[] = [];
    const skipped: string[] = [];
    for (let port = start_port; port < start_port + count; port++) {
      if (alreadyPorts.has(port)) {
        skipped.push(`${port} (already connected as "${alreadyPorts.get(port)}")`);
        continue;
      }
      const client = new DebugServerClient('127.0.0.1', port);
      try {
        await client.connect();
      } catch {
        continue; // nothing there - expected for most of the range, not an error
      }
      const id = `debug${port}`;
      const entry: InstanceEntry = { id, debug: client, pine: null, debugPort: port };
      instances.set(id, entry);
      await identifyInstance(entry); // best-effort
      const game = entry.label ? ` — "${entry.label}"${entry.serial ? ` (${entry.serial})` : ''}` : '';
      found.push(`${id} (port ${port})${game}`);
    }

    if (found.length > 0 && activeInstanceId === null) {
      activateInstance(found[0].split(' ')[0]);
    }

    const lines: string[] = [];
    lines.push(
      found.length > 0
        ? `Discovered and connected ${found.length} new instance(s):\n${found.map((f) => `  ${f}`).join('\n')}`
        : `No new instances found probing ports ${start_port}-${start_port + count - 1}.`,
    );
    if (skipped.length > 0) lines.push(`\nSkipped (already connected): ${skipped.join(', ')}`);
    if (found.length > 0 && instances.size === found.length)
      lines.push(`\nActive instance set to "${activeInstanceId}" (first one found, since nothing was active before).`);
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ==========================================================
//  TOOL: pcsx2_forget_instance (Phase 4: graceful cleanup)
// ==========================================================
server.tool(
  'pcsx2_forget_instance',
  'Remove an instance from the registry - use after a PCSX2 process has crashed/closed and you want it out of pcsx2_list_instances instead of it lingering as "disconnected". Does not affect any other instance\'s connection (each instance holds its own independent socket, so one dying was already isolated from the others - this just tidies bookkeeping). If the forgotten instance was active, no instance is active afterward until you pcsx2_connect or pcsx2_use_instance another one.',
  {
    instance_id: z
      .string()
      .describe('Exact id, or a substring matching id/game title/serial - same resolution rules as pcsx2_use_instance'),
  },
  async ({ instance_id }) => {
    try {
      const resolved = resolveInstanceId(instance_id);
      instances.delete(resolved);
      if (activeInstanceId === resolved) {
        activeInstanceId = null;
        debugServer = null;
        pine = null;
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Forgot instance "${resolved}" (${instances.size} instance(s) remaining).${activeInstanceId === null ? ' No instance is active now.' : ''}`,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
);

// ==========================================================
//  TOOL: pcsx2_status
// ==========================================================
server.tool(
  'pcsx2_status',
  'Get connection + emulator status.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      const p: string[] = [];
      p.push(
        `Active instance: ${activeInstanceId ?? '(none)'} — ${instances.size} instance(s) connected total (pcsx2_list_instances for details)`,
      );
      p.push(`DebugServer: ${hasDebug() ? '✅ connected' : '❌ not connected'}`);
      p.push(`Pine IPC:    ${hasPine() ? '✅ connected' : '❌ not connected'}`);
      if (hasDebug()) {
        try {
          const s = await debugServer!.getStatus();
          p.push(`EE PC: ${s.pc} | Paused: ${s.paused} | Cycles: ${s.cycles}`);
        } catch {}
      }
      if (hasPine()) {
        try {
          const t = await pine!.getTitle();
          const id = await pine!.getID();
          p.push(`Game: ${t} (${id})`);
        } catch {}
      }
      return { content: [{ type: 'text' as const, text: p.join('\n') }] };
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_read_memory
// ==========================================================
server.tool(
  'pcsx2_read_memory',
  'Read PS2 memory. Returns hex dump.',
  {
    address: z.string(),
    length: z.number().min(1).max(4096).default(256),
    format: z.enum(['hexdump', 'hex', 'u32_array', 'ascii']).default('hexdump'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, length, format, instance_id }) => {
    return withInstance(instance_id, async () => {
      try {
        const addr = parseAddr(address);
        const data = await readMem(addr, length);
        let text: string;
        if (format === 'hexdump') text = hexDump(data, addr);
        else if (format === 'hex') text = data.toString('hex');
        else if (format === 'u32_array') {
          const v: string[] = [];
          for (let i = 0; i + 3 < data.length; i += 4)
            v.push('0x' + data.readUInt32LE(i).toString(16).padStart(8, '0'));
          text = v.join(', ');
        } else text = data.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
        return {
          content: [{ type: 'text' as const, text: `Memory at 0x${addr.toString(16)} (${length}B):\n\n${text}` }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_read_memory_multiple
// ==========================================================
server.tool(
  'pcsx2_read_memory_multiple',
  "Batch memory read: one round-trip for many independent {address, length} reads, mirroring the read_multiple_files pattern. Use this instead of several sequential pcsx2_read_memory calls when checking a scattered set of known addresses (e.g. a watch list of struct fields, or several candidate pointers at once). A bad address in one entry doesn't fail the batch - that entry just comes back flagged as not fully valid. Requires DebugServer.",
  {
    reads: z
      .array(z.object({ address: z.string(), length: z.number().min(1).max(4096).default(4) }))
      .min(1)
      .max(64),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ reads, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const results = await debugServer!.readMemoryMultiple(reads, cpu);
        const lines = results.map(
          (r) => `${r.address} (${r.length}B)${r.allValid ? '' : ' [PARTIALLY INVALID]'}: ${r.hex}`,
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_write_memory
// ==========================================================
server.tool(
  'pcsx2_write_memory',
  'Write hex data to PS2 memory. USE WITH CAUTION.',
  {
    address: z.string(),
    data: z.string().describe('Hex data e.g. "0102030405"'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, data, instance_id }) => {
    return withInstance(instance_id, async () => {
      try {
        const addr = parseAddr(address);
        const buf = Buffer.from(data.replace(/\s/g, ''), 'hex');
        await writeMem(addr, buf);
        return { content: [{ type: 'text' as const, text: `Wrote ${buf.length} bytes to 0x${addr.toString(16)}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_read_string
// ==========================================================
server.tool(
  'pcsx2_read_string',
  'Read null-terminated string from PS2 memory.',
  {
    address: z.string(),
    max_length: z.number().default(256),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, max_length, instance_id }) => {
    return withInstance(instance_id, async () => {
      try {
        if (hasDebug()) {
          const str = await debugServer!.readString(address, max_length);
          return { content: [{ type: 'text' as const, text: `"${str}" (${str.length} chars)` }] };
        }
        const addr = parseAddr(address);
        const data = await readMem(addr, max_length);
        const idx = data.indexOf(0);
        const str = data.subarray(0, idx >= 0 ? idx : data.length).toString('ascii');
        return { content: [{ type: 'text' as const, text: `"${str}" (${str.length} chars)` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_read_registers (DebugServer - FULL 128-bit!)
// ==========================================================
server.tool(
  'pcsx2_read_registers',
  'Read ALL EE registers — FULL 128-bit values. Categories: GPR, CP0, FPR, FCR, VU0F, VU0I, GSPRIV. Requires DebugServer.',
  {
    category: z
      .number()
      .min(-1)
      .max(6)
      .default(-1)
      .describe('-1 for all, 0=GPR, 1=CP0, 2=FPR, 3=FCR, 4=VU0F, 5=VU0I, 6=GSPRIV'),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ category, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: DebugServer not connected. Patch PCSX2 with pcsx2-plugin/DebugServer.cpp',
            },
          ],
          isError: true,
        };
      try {
        const cat = category >= 0 ? category : undefined;
        const data = await debugServer!.readRegisters(cpu, cat);
        // Format nicely
        const lines: string[] = [`=== ${cpu.toUpperCase()} Registers ===`, ''];
        for (const [catName, catData] of Object.entries(data)) {
          if (catName === 'pc' || catName === 'hi' || catName === 'lo') continue;
          const cd = catData as any;
          if (!cd.regs) continue;
          lines.push(`--- ${catName} (${cd.size}-bit × ${cd.count}) ---`);
          for (const reg of cd.regs) {
            lines.push(`  ${(reg.name as string).padEnd(10)} = ${reg.display}`);
          }
          lines.push('');
        }
        if (data.pc) lines.push(`PC = ${data.pc}`);
        if (data.hi) lines.push(`HI = ${data.hi}`);
        if (data.lo) lines.push(`LO = ${data.lo}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_read_vu1_registers
// ==========================================================
server.tool(
  'pcsx2_read_vu1_registers',
  "Read VU1 registers (VF float + VI integer, full 128-bit). VU0/GS registers are already covered by pcsx2_read_registers (categories VU0F/VU0I/GSPRIV) - VU1 needs this separate command since it isn't part of that same category contract. Requires DebugServer.",
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const data = await debugServer!.readVU1Registers();
        const lines: string[] = ['=== VU1 Registers ===', ''];
        for (const [catName, catData] of Object.entries(data)) {
          const cd = catData as any;
          if (!cd.regs) continue;
          lines.push(`--- ${catName} (${cd.size}-bit × ${cd.count}) ---`);
          for (const reg of cd.regs) {
            lines.push(`  ${(reg.name as string).padEnd(10)} = ${reg.value}`);
          }
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_read_vu_micromem
// ==========================================================
server.tool(
  'pcsx2_read_vu_micromem',
  'Dump VU0/VU1 instruction memory (imem) as a raw hex string. VU0 micro-mem is 4KB (0x1000, offsets 0-0xFFC), VU1 is 16KB (0x4000, offsets 0-0x3FF8). This is raw bytes for tooling/diffing - for a human-readable view of the actual code, use pcsx2_disassemble_vu instead. Requires DebugServer.',
  {
    vu: z.union([z.literal(0), z.literal(1)]).default(0),
    address: z.number().min(0).default(0).describe('Byte offset into VU micro-mem'),
    length: z.number().min(1).max(16384).default(256),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ vu, address, length, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const { hex, progSize } = await debugServer!.readVUMicroMem(vu, address, length);
        const buf = Buffer.from(hex, 'hex');
        return {
          content: [
            {
              type: 'text' as const,
              text: `VU${vu} micro-mem at 0x${address.toString(16)} (prog_size=0x${progSize.toString(16)}):\n\n${hexDump(buf, address)}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_disassemble_vu
// ==========================================================
server.tool(
  'pcsx2_disassemble_vu',
  "Disassemble VU0/VU1 microcode using PCSX2's own disVU0Micro*/disVU1Micro* disassembler functions - the actual VU instruction set (dual-issue upper/lower pipelines every 8 bytes), NOT MIPS. This is what runs when a game offloads physics/collision/skinning to VU via vcallms/vcallmsr (VU0) or VIF1 MSCAL/MSCNT (VU1) - invisible to EE-side breakpoints/watchpoints, since the EE only ever sees the *trigger* instruction, never the VU code itself executing. Each line shows the upper-pipeline op and the lower-pipeline op side by side, plus the I/E/M/D/T flag bits (I = lower word is a raw float immediate, not an opcode; E = end of microprogram, but real hardware still runs 2 more instructions after E is set - don't assume the listing should stop there). Requires DebugServer.",
  {
    vu: z.union([z.literal(0), z.literal(1)]).default(0),
    address: z
      .number()
      .min(0)
      .default(0)
      .describe('Byte offset into VU micro-mem, auto-aligned down to a multiple of 8'),
    count: z.number().min(1).max(500).default(20),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ vu, address, count, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const instrs = await debugServer!.disassembleVU(vu, address, count);
        const lines = instrs.map((i) => {
          const flagChars = `${i.flags.i ? 'I' : '-'}${i.flags.e ? 'E' : '-'}${i.flags.m ? 'M' : '-'}${i.flags.d ? 'D' : '-'}${i.flags.t ? 'T' : '-'}`;
          return `${i.address} [${flagChars}]  UPPER: ${i.upper.padEnd(28)}  LOWER: ${i.lower}`;
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `VU${vu} microcode disassembly (${instrs.length} instructions):\n\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_set_vu_breakpoint / remove / list / clear
// ==========================================================
server.tool(
  'pcsx2_set_vu_breakpoint',
  'Set a VU-side address breakpoint (breaks when VU0/VU1\'s TPC reaches this micro-mem byte address). IMPORTANT LIMITATION: this only fires while the affected VU is running under PCSX2\'s *interpreter* - unlike the EE/IOP recompilers, PCSX2\'s default microVU JIT recompiler has no per-instruction breakpoint mechanism at all, so a VU running under it will silently never hit this breakpoint. If the response includes a warning, go to System > Emulation in PCSX2 and uncheck "Enable VU0 Recompiler" / "Enable VU1 Recompiler" for the VU you\'re investigating (interpreted VU is meaningfully slower, so only disable it for that one VU, not both). This is the direct way to catch a vcallms/vcallmsr (VU0) or VIF1 MSCAL (VU1) target the moment it starts executing, instead of inferring it after the fact. KNOWN ISSUE: resuming from a hit VU breakpoint can trigger a real, self-recovering 5-60s+ stall (VU cycle catch-up) - not a hang, do NOT kill the process, just wait. Requires DebugServer.',
  {
    vu: z.union([z.literal(0), z.literal(1)]).default(0),
    address: z.number().min(0).describe('Byte offset into VU micro-mem, auto-aligned down to a multiple of 8'),
    description: z.string().optional(),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ vu, address, description, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const { warning } = await debugServer!.setVUBreakpoint(vu, address, description);
        let msg = `VU${vu} breakpoint set at 0x${address.toString(16)}`;
        if (warning) msg += `\n\n⚠️  ${warning}`;
        return { content: [{ type: 'text' as const, text: msg }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_remove_vu_breakpoint',
  'Remove a VU-side address breakpoint.',
  {
    vu: z.union([z.literal(0), z.literal(1)]).default(0),
    address: z.number().min(0),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ vu, address, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        await debugServer!.removeVUBreakpoint(vu, address);
        return {
          content: [{ type: 'text' as const, text: `VU${vu} breakpoint removed at 0x${address.toString(16)}` }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_list_vu_breakpoints',
  'List VU0/VU1 breakpoints. Omit vu to list both.',
  {
    vu: z.union([z.literal(0), z.literal(1)]).optional(),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ vu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const bps = await debugServer!.listVUBreakpoints(vu);
        if (bps.length === 0) return { content: [{ type: 'text' as const, text: 'No VU breakpoints set.' }] };
        const lines = bps.map((bp) => `VU${bp.vu} ${bp.address}${bp.description ? ` — ${bp.description}` : ''}`);
        return { content: [{ type: 'text' as const, text: `${bps.length} VU breakpoint(s):\n${lines.join('\n')}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_clear_vu_breakpoints',
  'Clear VU0/VU1 breakpoints. Omit vu to clear both.',
  {
    vu: z.union([z.literal(0), z.literal(1)]).optional(),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ vu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        await debugServer!.clearVUBreakpoints(vu);
        return {
          content: [
            {
              type: 'text' as const,
              text: vu !== undefined ? `VU${vu} breakpoints cleared.` : 'VU0 and VU1 breakpoints cleared.',
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_get_gs_context
// ==========================================================
server.tool(
  'pcsx2_get_gs_context',
  'Full GS drawing-context/environment state: both drawing contexts (TEX0/CLAMP/ALPHA/TEST/FRAME/ZBUF/etc, decoded + raw hex) and environment-level state (PRIM/blend mode/fog color/etc). GS has no programmable microcode to disassemble like VU does - this is the analogous "what is GS actually doing right now" feature, useful for texture/rendering bugs. Requires DebugServer.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.getGSContext();
        if (!r.gs_ready)
          return { content: [{ type: 'text' as const, text: 'GS is not ready yet (no frame rendered since boot).' }] };

        const lines: string[] = [`Active context: ${r.active_context}`, ''];
        const e = r.environment;
        lines.push('--- Environment ---');
        lines.push(
          `PRIM: type=${e.prim.prim} iip=${e.prim.iip} tme=${e.prim.tme} fge=${e.prim.fge} abe=${e.prim.abe} fst=${e.prim.fst} ctxt=${e.prim.ctxt} (${e.prim.raw})`,
        );
        lines.push(`COLCLAMP: ${e.colclamp.clamp} | DTHE: ${e.dthe.dthe} | SCANMSK: ${e.scanmsk.msk}`);
        lines.push(`FOGCOL: R=${e.fogcol.r} G=${e.fogcol.g} B=${e.fogcol.b}`);
        lines.push('');

        for (const ctx of r.contexts) {
          lines.push(`--- Context ${ctx.index}${ctx.active ? ' (ACTIVE)' : ''} ---`);
          lines.push(
            `TEX0: TBP0=0x${ctx.tex0.tbp0.toString(16)} TBW=${ctx.tex0.tbw} PSM=0x${ctx.tex0.psm.toString(16)} TW=${ctx.tex0.tw} TH=${ctx.tex0.th} TCC=${ctx.tex0.tcc} (${ctx.tex0.raw})`,
          );
          lines.push(
            `CLAMP: WMS=${ctx.clamp.wms} WMT=${ctx.clamp.wmt} U=[${ctx.clamp.minu},${ctx.clamp.maxu}] V=[${ctx.clamp.minv},${ctx.clamp.maxv}]`,
          );
          lines.push(
            `SCISSOR: X=[${ctx.scissor.scax0},${ctx.scissor.scax1}] Y=[${ctx.scissor.scay0},${ctx.scissor.scay1}]`,
          );
          lines.push(
            `ALPHA: A=${ctx.alpha.a} B=${ctx.alpha.b} C=${ctx.alpha.c} D=${ctx.alpha.d} FIX=0x${ctx.alpha.fix.toString(16)}`,
          );
          lines.push(
            `TEST: ATE=${ctx.test.ate} ATST=${ctx.test.atst} AREF=${ctx.test.aref} ZTE=${ctx.test.zte} ZTST=${ctx.test.ztst} DATE=${ctx.test.date}`,
          );
          lines.push(
            `FRAME: FBP=0x${ctx.frame.fbp.toString(16)} FBW=${ctx.frame.fbw} PSM=0x${ctx.frame.psm.toString(16)} FBMSK=${ctx.frame.fbmsk}`,
          );
          lines.push(
            `ZBUF: ZBP=0x${ctx.zbuf.zbp.toString(16)} PSM=0x${ctx.zbuf.psm.toString(16)} ZMSK=${ctx.zbuf.zmsk}`,
          );
          lines.push(`XYOFFSET: OFX=0x${ctx.xyoffset.ofx.toString(16)} OFY=0x${ctx.xyoffset.ofy.toString(16)}`);
          lines.push('');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_get_screenshot  [STUBBED FROM LLM VIEW]
//  Works perfectly server-side, but Claude Desktop doesn't render the
//  returned image content block immediately/reliably. Keeping the full
//  implementation intact below (dead code, not registered) so it can be
//  re-enabled with a single uncomment once that's sorted out.
// ==========================================================
/*
server.tool('pcsx2_get_screenshot',
  'Capture the currently rendered PS2 frame as an image, returned inline so it can be viewed directly. Pairs well with pcsx2_get_gs_context for correlating GS register state with what it actually produces on screen - e.g. confirm a texture/blend bug visually, or check what\'s on screen before deciding where to breakpoint. width/height=0 (default) uses GS\'s native internal render resolution. Requires DebugServer.',
  {
    format: z.enum(['png', 'jpg', 'webp']).default('png'),
    quality: z.number().min(1).max(100).default(85).describe('Only affects jpg/webp - png always uses lossless compression'),
    width: z.number().min(0).default(0).describe('0 = native internal render resolution'),
    height: z.number().min(0).default(0),
  },
  async ({ format, quality, width, height }) => {
    if (!hasDebug()) return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
    try {
      const r = await debugServer!.getScreenshot({ format, quality, width, height });
      const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
      return {
        content: [
          { type: 'text' as const, text: `Captured ${r.width}x${r.height} frame (${format}, ${r.encodedBytes} bytes encoded).` },
          { type: 'image' as const, data: r.dataBase64, mimeType },
        ],
      };
    } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }; }
  }
);
*/

// ==========================================================
//  TOOL: pcsx2_write_register
// ==========================================================
server.tool(
  'pcsx2_write_register',
  'Write a register value (supports full 128-bit hex). Requires DebugServer.',
  {
    category: z.number().default(0).describe('0=GPR, 1=CP0, 2=FPR, etc.'),
    index: z.number().describe('Register index within category'),
    value: z.string().describe('Hex value (up to 128-bit)'),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ category, index, value, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        await debugServer!.writeRegister(category, index, value, cpu);
        return { content: [{ type: 'text' as const, text: `Set cat=${category} reg=${index} = ${value}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_disassemble (NATIVE PCSX2!)
// ==========================================================
server.tool(
  'pcsx2_disassemble',
  "Disassemble MIPS instructions using PCSX2's NATIVE disassembler — perfect output. Requires DebugServer.",
  {
    address: z.string(),
    count: z.number().min(1).max(200).default(20),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, count, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const instrs = await debugServer!.disassemble(address, count, true, cpu);
        const text = instrs.map((i) => `${i.address}:  ${(i.opcode as string).padEnd(12)}  ${i.disasm}`).join('\n');
        return { content: [{ type: 'text' as const, text: `Disassembly (${count} instructions):\n\n${text}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_evaluate (EXPRESSION EVAL!)
// ==========================================================
server.tool(
  'pcsx2_evaluate',
  'Evaluate a MIPS expression with full symbol support. Examples: "v0 + 0x100", "gp + 0x20", "sp - 4". Requires DebugServer.',
  {
    expression: z.string().describe('Expression to evaluate'),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ expression, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.evaluate(expression, cpu);
        if (r.ok) return { content: [{ type: 'text' as const, text: `"${expression}" = ${r.hex} (${r.result})` }] };
        else return { content: [{ type: 'text' as const, text: `Eval error: ${r.error}` }], isError: true };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_set_breakpoint (with CONDITIONAL!)
// ==========================================================
server.tool(
  'pcsx2_set_breakpoint',
  'Set a breakpoint at an address. Supports conditional expressions! Requires DebugServer.',
  {
    address: z.string(),
    condition: z.string().optional().describe('Break only when expression is true, e.g. "v0 == 0x42"'),
    description: z.string().optional(),
    temporary: z.boolean().default(false),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, condition, description, temporary, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        await debugServer!.setBreakpoint(address, { condition, description, temporary });
        let msg = `Breakpoint set at ${address}`;
        if (condition) msg += ` [condition: ${condition}]`;
        return { content: [{ type: 'text' as const, text: msg }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_remove_breakpoint',
  'Remove a breakpoint.',
  {
    address: z.string(),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        await debugServer!.removeBreakpoint(address);
        return { content: [{ type: 'text' as const, text: `Breakpoint removed at ${address}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_list_breakpoints',
  'List all breakpoints with their conditions and hit status.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const bps = await debugServer!.listBreakpoints();
        if (bps.length === 0) return { content: [{ type: 'text' as const, text: 'No breakpoints set.' }] };
        const lines = bps.map((bp) => {
          let s = `${bp.address} ${bp.enabled ? '✅' : '❌'}`;
          if (bp.has_condition) s += ` [cond: ${bp.condition}]`;
          if (bp.description) s += ` — ${bp.description}`;
          if (bp.temporary) s += ' (temp)';
          return s;
        });
        return { content: [{ type: 'text' as const, text: `${bps.length} breakpoint(s):\n${lines.join('\n')}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_set_watchpoint (with onChange!)
// ==========================================================
server.tool(
  'pcsx2_set_watchpoint',
  'Set a memory watchpoint. Supports read/write/access/onchange + optional condition expression! IMPORTANT: this only fires on CPU (EE/IOP) load/store instructions actually touching the range - it does NOT fire on DMAC transfers (VIF/GIF/SIF/IPU/etc DMA writes bypass the CPU load/store path entirely and this watchpoint mechanism cannot see them). If a value changes but no watchpoint fires, suspect a DMA transfer before assuming the watchpoint is broken - PS2 games routinely move data via DMA (e.g. VU1 chains via VIF1, texture uploads via GIF) with no CPU store instruction ever executing at the destination address.',
  {
    address: z.string(),
    end: z.string().optional().describe('End address (default: address+4)'),
    type: z.enum(['read', 'write', 'readwrite', 'onchange']).default('write'),
    action: z.enum(['break', 'log', 'both']).default('break'),
    condition: z.string().optional(),
    description: z.string().optional(),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, end, type, action, condition, description, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const endAddr = end || '0x' + (parseAddr(address) + 4).toString(16);
        await debugServer!.setMemcheck(address, endAddr, { type, action, condition, description });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Watchpoint (${type}/${action}) set at ${address}-${endAddr}${condition ? ` [cond: ${condition}]` : ''}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_remove_watchpoint',
  'Remove a memory watchpoint.',
  {
    address: z.string(),
    end: z.string().optional(),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, end, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const endAddr = end || '0x' + (parseAddr(address) + 4).toString(16);
        await debugServer!.removeMemcheck(address, endAddr);
        return { content: [{ type: 'text' as const, text: `Watchpoint removed at ${address}-${endAddr}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_list_watchpoints',
  'List all memory watchpoints with hit counts.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const mcs = await debugServer!.listMemchecks();
        if (mcs.length === 0) return { content: [{ type: 'text' as const, text: 'No watchpoints set.' }] };
        const lines = mcs.map(
          (mc) =>
            `${mc.start}-${mc.end} | ${mc.hits} hits | last_PC=${mc.last_pc}${mc.description ? ` — ${mc.description}` : ''}`,
        );
        return { content: [{ type: 'text' as const, text: `${mcs.length} watchpoint(s):\n${lines.join('\n')}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_step / step_over / continue / pause
// ==========================================================
server.tool(
  'pcsx2_step',
  'Execute one MIPS instruction. Returns new PC + native disasm. Requires DebugServer.',
  {
    count: z.number().min(1).max(100).default(1),
    show_registers: z.boolean().default(false),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ count, show_registers, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const results: string[] = [];
        for (let i = 0; i < count; i++) {
          const r = await debugServer!.step();
          const warn = r.timed_out ? ' (WARNING: timed out - VM is still running, not paused)' : '';
          results.push(`Step ${i + 1}: PC=${r.new_pc}  ${r.opcode}  ${r.disasm}${warn}`);
          if (r.timed_out) break; // further steps would race against a live, running VM
        }
        if (show_registers) {
          const regs = await debugServer!.readRegisters('ee', 0); // GPR only
          results.push('', '--- GPR ---');
          for (const reg of (regs as any).GPR?.regs || [])
            results.push(`  ${(reg.name as string).padEnd(6)} = ${reg.display}`);
        }
        return { content: [{ type: 'text' as const, text: results.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_step_over',
  'Step OVER a JAL/JALR call — like "next" in a debugger. Requires DebugServer.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.stepOver();
        const warn = r.timed_out ? ' (WARNING: timed out - VM is still running, not paused)' : '';
        return {
          content: [{ type: 'text' as const, text: `Stepped over: ${r.old_pc} → ${r.new_pc}\n${r.disasm}${warn}` }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_continue',
  'Resume execution until breakpoint or halt.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.resume();
        return { content: [{ type: 'text' as const, text: `Resumed (paused=${r.paused}). Use pcsx2_pause to stop.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_resume_and_wait',
  'Resume and block until the VM pauses again (breakpoint/watchpoint hit) or the timeout elapses. Unlike pcsx2_continue, this tells you exactly when/whether a breakpoint fired instead of requiring a polling loop with pcsx2_status. Requires DebugServer.',
  {
    timeout_ms: z.number().min(100).max(60000).default(10000),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ timeout_ms, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.resumeAndWait(timeout_ms);
        const text = r.timedOut
          ? `Timed out after ${timeout_ms}ms — VM is still running, not paused. No breakpoint fired (or it hasn't yet).`
          : `Paused at ${r.pc} — breakpoint/watchpoint hit (or something else paused it).`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_pause',
  'Pause/halt the emulator. Returns current PC.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.pause();
        return { content: [{ type: 'text' as const, text: `Paused at PC=${r.pc}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_get_threads / pcsx2_get_modules
// ==========================================================
server.tool(
  'pcsx2_get_threads',
  'List EE/IOP BIOS threads with their status.',
  {
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const threads = await debugServer!.getThreads(cpu);
        if (threads.length === 0) return { content: [{ type: 'text' as const, text: 'No threads.' }] };
        const lines = threads.map((t) => `TID ${t.id}: PC=${t.pc} status=${t.status} waitType=${t.wait_type}`);
        return { content: [{ type: 'text' as const, text: `${threads.length} threads:\n${lines.join('\n')}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_get_modules',
  'List loaded IOP modules.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const mods = await debugServer!.getModules('iop');
        const lines = mods.map((m) => `${m.name} (v${m.version})`);
        return { content: [{ type: 'text' as const, text: `${mods.length} modules:\n${lines.join('\n')}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_get_backtrace
// ==========================================================
server.tool(
  'pcsx2_get_backtrace',
  'Get call stack backtrace (stack walk). Shows function entry points, PCs, stack pointers, and disassembly for each frame. Requires DebugServer + paused state.',
  {
    cpu: z.enum(['ee', 'iop']).default('ee'),
    max_frames: z.number().min(1).max(128).default(32),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ cpu, max_frames, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const frames = await debugServer!.getBacktrace(cpu, max_frames);
        if (frames.length === 0)
          return {
            content: [{ type: 'text' as const, text: 'No stack frames (may not be paused, or no thread running).' }],
          };
        const lines = frames.map(
          (f, i) => `#${i} entry=${f.entry} pc=${f.pc} sp=${f.sp} size=${f.stack_size}  ${f.disasm}`,
        );
        return {
          content: [{ type: 'text' as const, text: `Call stack (${frames.length} frames):\n${lines.join('\n')}` }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_game_info / save_state / load_state (Pine)
// ==========================================================
server.tool(
  'pcsx2_game_info',
  'Get game title, ID, version from PCSX2. Requires Pine.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasPine())
        return { content: [{ type: 'text' as const, text: 'Error: Pine not connected.' }], isError: true };
      try {
        const [t, id, uuid, gv, ev, st] = await Promise.all([
          pine!.getTitle(),
          pine!.getID(),
          pine!.getUUID(),
          pine!.getGameVersion(),
          pine!.getVersion(),
          pine!.getStatus(),
        ]);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Title: ${t}\nID: ${id}\nUUID: ${uuid}\nGame: ${gv}\nPCSX2: ${ev}\nStatus: ${st === EmuStatus.Running ? 'Running' : st === EmuStatus.Paused ? 'Paused' : 'Shutdown'}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_save_state',
  'Save emulator state. Requires Pine.',
  {
    slot: z.number().min(0).max(9),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ slot, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasPine()) return { content: [{ type: 'text' as const, text: 'Pine not connected.' }], isError: true };
      try {
        await pine!.saveState(slot);
        return { content: [{ type: 'text' as const, text: `Saved to slot ${slot}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_load_state',
  'Load emulator state. Requires Pine.',
  {
    slot: z.number().min(0).max(9),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ slot, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasPine()) return { content: [{ type: 'text' as const, text: 'Pine not connected.' }], isError: true };
      try {
        await pine!.loadState(slot);
        return { content: [{ type: 'text' as const, text: `Loaded from slot ${slot}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_find_pattern
// ==========================================================
server.tool(
  'pcsx2_find_pattern',
  'Search PS2 memory for a hex pattern. Use ?? for wildcards.',
  {
    pattern: z.string(),
    start: z.string().default('0x00100000'),
    end: z.string().default('0x02000000'),
    max_results: z.number().default(20),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ pattern, start, end, max_results, instance_id }) => {
    return withInstance(instance_id, async () => {
      try {
        const startAddr = parseAddr(start);
        const endAddr = parseAddr(end);
        const parts = pattern.replace(/\s/g, '').match(/.{2}/g) || [];
        const pat = parts.map((p) => (p === '??' ? null : parseInt(p, 16)));
        if (pat.length === 0) return { content: [{ type: 'text' as const, text: 'Empty pattern' }], isError: true };
        const results: number[] = [];
        const chunk = 4096;
        for (let a = startAddr; a < endAddr && results.length < max_results; a += chunk) {
          let data: Buffer;
          try {
            data = await readMem(a, Math.min(chunk + pat.length, endAddr - a));
          } catch {
            continue;
          }
          for (let i = 0; i <= data.length - pat.length && results.length < max_results; i++) {
            let ok = true;
            for (let j = 0; j < pat.length; j++) {
              if (pat[j] !== null && data[i + j] !== pat[j]) {
                ok = false;
                break;
              }
            }
            if (ok) results.push(a + i);
          }
        }
        if (results.length === 0) return { content: [{ type: 'text' as const, text: `No matches for "${pattern}"` }] };
        return {
          content: [
            {
              type: 'text' as const,
              text: `${results.length} match(es):\n${results.map((a) => '0x' + a.toString(16).padStart(8, '0')).join('\n')}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_memory_diff
// ==========================================================
server.tool(
  'pcsx2_memory_diff',
  'Snapshot-and-compare memory. First call = snapshot, second = diff.',
  {
    address: z.string(),
    length: z.number().default(256),
    name: z.string().default('default'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, length, name, instance_id }) => {
    return withInstance(instance_id, async () => {
      try {
        const addr = parseAddr(address);
        const data = await readMem(addr, length);
        const key = `${name}_${addr}_${length}`;
        if (!memSnapshots.has(key)) {
          memSnapshots.set(key, { addr, data });
          return { content: [{ type: 'text' as const, text: `Snapshot "${name}" saved. Call again to diff.` }] };
        }
        const prev = memSnapshots.get(key)!;
        memSnapshots.delete(key);
        const changes: string[] = [];
        for (let i = 0; i < Math.min(prev.data.length, data.length); i++) {
          if (prev.data[i] !== data[i])
            changes.push(
              `  +0x${i.toString(16).padStart(4, '0')} (0x${(addr + i).toString(16)}): ${prev.data[i].toString(16).padStart(2, '0')} → ${data[i].toString(16).padStart(2, '0')}`,
            );
        }
        if (changes.length === 0) return { content: [{ type: 'text' as const, text: 'No changes.' }] };
        return {
          content: [{ type: 'text' as const, text: `${changes.length} byte(s) changed:\n${changes.join('\n')}` }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: pcsx2_clear_all_breakpoints
// ==========================================================
server.tool(
  'pcsx2_clear_all_breakpoints',
  'Clear ALL breakpoints and watchpoints.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        await debugServer!.clearAllBreakpoints();
        return { content: [{ type: 'text' as const, text: 'All breakpoints and watchpoints cleared.' }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  PS2Recomp Integration Tools
// ==========================================================
server.tool(
  'ps2recomp_lookup_function',
  'Search PS2Recomp project for functions by address or name.',
  {
    query: z.string(),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ query, instance_id }) => {
    return withInstance(instance_id, async () => {
      try {
        const results: string[] = [];
        const overDir = path.join(PS2RECOMP_ROOT, 'ps2xRuntime', 'src', 'lib', 'overrides');
        if (fs.existsSync(overDir)) {
          for (const f of fs.readdirSync(overDir).filter((f) => f.endsWith('.cpp'))) {
            if (f.toLowerCase().includes(query.toLowerCase().replace(/^0x/, ''))) {
              const c = fs.readFileSync(path.join(overDir, f), 'utf8');
              const m = c.match(/RECOMP_FUNC\s+(\w+)/);
              results.push(`Override: ${f}${m ? ` → ${m[1]}` : ''}`);
            }
          }
        }
        for (const d of ['configs', 'config']) {
          const dir = path.join(PS2RECOMP_ROOT, d);
          if (!fs.existsSync(dir)) continue;
          for (const f of fs
            .readdirSync(dir, { recursive: true })
            .filter((f): f is string => typeof f === 'string' && f.endsWith('.toml'))) {
            const c = fs.readFileSync(path.join(dir, f), 'utf8');
            if (c.toLowerCase().includes(query.toLowerCase())) {
              const lines = c.split('\n').filter((l) => l.toLowerCase().includes(query.toLowerCase()));
              results.push(`Config: ${f}`);
              lines.slice(0, 3).forEach((l) => results.push(`  ${l.trim()}`));
            }
          }
        }
        return {
          content: [
            { type: 'text' as const, text: results.length > 0 ? results.join('\n') : `No results for "${query}"` },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'ps2recomp_list_overrides',
  'List all PS2Recomp function overrides.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      try {
        const dir = path.join(PS2RECOMP_ROOT, 'ps2xRuntime', 'src', 'lib', 'overrides');
        if (!fs.existsSync(dir))
          return { content: [{ type: 'text' as const, text: 'Override dir not found' }], isError: true };
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.cpp'))
          .sort();
        const lines = files.map((f) => {
          const m = f.match(/0x([0-9a-fA-F]+)/);
          return `  ${m ? '0x' + m[1] : '?'.padEnd(12)} ${f}`;
        });
        return { content: [{ type: 'text' as const, text: `${files.length} overrides:\n${lines.join('\n')}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: Symbol Intelligence (SymbolGuardian)
// ==========================================================
server.tool(
  'pcsx2_resolve_address',
  'Resolve an address to its symbol name + offset, if known. Works even without a running VM if debug symbols are loaded. Requires DebugServer.',
  {
    address: z.string(),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.resolveAddress(address, cpu);
        if (!r.found) return { content: [{ type: 'text' as const, text: `No symbol found at ${address}` }] };
        const offsetStr = r.offset ? ` + 0x${r.offset.toString(16)}` : '';
        return {
          content: [{ type: 'text' as const, text: `${r.name}${offsetStr} (base ${r.address}, size ${r.size})` }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_find_symbol',
  'Look up the address of a named symbol/function. Requires DebugServer.',
  {
    name: z.string(),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ name, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.findSymbol(name, cpu);
        if (!r.found) return { content: [{ type: 'text' as const, text: `No symbol named "${name}"` }] };
        return { content: [{ type: 'text' as const, text: `${name} = ${r.address} (size ${r.size})` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_get_function_info',
  'Get the function containing an address: name, boundaries, no-return flag. Requires DebugServer.',
  {
    address: z.string(),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.getFunctionInfo(address, cpu);
        if (!r.found) return { content: [{ type: 'text' as const, text: `No known function contains ${address}` }] };
        return {
          content: [
            {
              type: 'text' as const,
              text: `${r.name} @ ${r.address} (size ${r.size}${r.is_no_return ? ', no-return' : ''})`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_list_functions',
  'List known functions, optionally restricted to an address range. Symbols come from loaded debug info or pcsx2_scan_functions. Requires DebugServer.',
  {
    start: z.string().optional(),
    end: z.string().optional(),
    limit: z.number().min(1).max(2000).default(200),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ start, end, limit, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const { total_count, functions } = await debugServer!.listFunctions({ start, end, limit, cpu });
        if (functions.length === 0)
          return { content: [{ type: 'text' as const, text: 'No functions found in that range.' }] };
        const lines = functions.map((f) => `${f.address}  ${f.name.padEnd(32)} size=${f.size}`);
        return {
          content: [
            { type: 'text' as const, text: `${total_count} total, showing ${functions.length}:\n${lines.join('\n')}` },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: Code Analysis
// ==========================================================
server.tool(
  'pcsx2_decode_instruction',
  'Structured decode of one instruction: branch target/condition, data-access address, etc. - everything MIPSAnalyst knows without re-deriving it from the disasm string. Requires DebugServer.',
  {
    address: z.string(),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const info = await debugServer!.decodeInstruction(address, cpu);
        const lines = [`Address: ${info.address}  Opcode: ${info.opcode}`];
        if (info.is_branch)
          lines.push(
            `Branch${info.is_conditional ? ' (conditional' + (info.condition_met ? ', TAKEN' : ', not taken') + ')' : ''} -> ${info.branch_target}${info.is_linked_branch ? ' (linked)' : ''}`,
          );
        if (info.is_branch_to_register) lines.push(`Branch to register #${info.branch_register_num}`);
        if (info.is_syscall) lines.push('Syscall');
        if (info.is_data_access) lines.push(`Data access: ${info.data_size} bytes @ ${info.data_address}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_assemble',
  'Assemble one MIPS instruction (e.g. "addiu a0, a0, 4") into its encoded opcode. Pair with pcsx2_write_memory to patch code live. Requires DebugServer.',
  {
    address: z.string(),
    instruction: z.string(),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ address, instruction, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const opcode = await debugServer!.assemble(address, instruction, cpu);
        return { content: [{ type: 'text' as const, text: `${instruction} -> ${opcode}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_scan_functions',
  'Heuristically detect function boundaries in a range with no debug info (typical for retail games). Adds them to the symbol database, visible afterward via pcsx2_list_functions/pcsx2_resolve_address. Requires DebugServer.',
  {
    start: z.string(),
    end: z.string(),
    generate_hashes: z.boolean().default(true),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ start, end, generate_hashes, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.scanFunctions(start, end, { generateHashes: generate_hashes, cpu });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Functions: ${r.functions_before} -> ${r.functions_after} (+${r.functions_added})`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: Memory Search (Cheat-Engine-style scanner)
// ==========================================================
const memValueTypeEnum = z.enum(['u8', 's8', 'u16', 's16', 'u32', 's32', 'u64', 'float']);
const memComparisonEnum = z.enum([
  'equals',
  'not_equals',
  'greater',
  'less',
  'greater_equal',
  'less_equal',
  'changed',
  'unchanged',
  'increased',
  'decreased',
]);

server.tool(
  'pcsx2_search_memory_start',
  'Start a memory value scan over an address range (Cheat-Engine style). Omit comparison/value to capture all addresses as a baseline for a later "changed"/"increased" scan. Requires DebugServer.',
  {
    start: z.string(),
    end: z.string().optional(),
    type: memValueTypeEnum.default('u32'),
    comparison: memComparisonEnum.optional(),
    value: z.number().optional(),
    cpu: z.enum(['ee', 'iop']).default('ee'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ start, end, type, comparison, value, cpu, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.searchMemoryStart({ start, end, type, comparison, value, cpu });
        return { content: [{ type: 'text' as const, text: `${r.candidateCount} candidates (type ${r.type})` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_search_memory_next',
  "Narrow the current memory scan's candidates by re-checking each address against a comparison (e.g. after the in-game value changed). Requires DebugServer.",
  {
    comparison: memComparisonEnum,
    value: z.number().optional(),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ comparison, value, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.searchMemoryNext(comparison, value);
        return { content: [{ type: 'text' as const, text: `${r.candidateCount} candidates remaining` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_search_memory_results',
  "List the current memory scan's candidate addresses and values. Requires DebugServer.",
  {
    limit: z.number().min(1).max(500).default(50),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ limit, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.searchMemoryResults(limit);
        if (r.results.length === 0) return { content: [{ type: 'text' as const, text: 'No candidates.' }] };
        const lines = r.results.map((c) => `${c.address}  = ${c.value}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `${r.candidateCount} total (type ${r.type}), showing ${r.results.length}:\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_search_memory_reset',
  'Clear the current memory scan session. Requires DebugServer.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        await debugServer!.searchMemoryReset();
        return { content: [{ type: 'text' as const, text: 'Scan session cleared.' }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: VM / Session Control
// ==========================================================
server.tool(
  'pcsx2_get_game_info',
  "Get the currently loaded game's title, serial, ELF path, and CRC. Requires DebugServer.",
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const info = await debugServer!.getGameInfo();
        if (!info.alive) return { content: [{ type: 'text' as const, text: 'No VM running.' }] };
        return {
          content: [
            {
              type: 'text' as const,
              text: `${info.title}\nSerial: ${info.serial}  CRC: ${info.crc}\nELF: ${info.elf}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_reset_vm',
  'Cold-reset the running VM (e.g. to restart a repro from scratch). Requires DebugServer.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.resetVM();
        return { content: [{ type: 'text' as const, text: `VM reset. paused=${r.paused}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_frame_advance',
  'Advance emulation by N frames (e.g. while paused, to step forward a controlled amount). Blocks until the VM has actually re-paused. Requires DebugServer.',
  {
    frames: z.number().min(1).max(3600).default(1),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ frames, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.frameAdvance(frames);
        const note = r.timedOut ? ' (WARNING: timed out waiting for re-pause)' : '';
        return { content: [{ type: 'text' as const, text: `Advanced ${frames} frame(s), now at ${r.pc}${note}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_save_state_slot',
  'Save state to a numbered slot (0-9). Requires DebugServer.',
  {
    slot: z.number().min(0).max(9),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ slot, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.saveStateSlot(slot);
        return { content: [{ type: 'text' as const, text: `Saved to slot ${slot}. paused=${r.paused}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_load_state_slot',
  'Load state from a numbered slot (0-9). Requires DebugServer.',
  {
    slot: z.number().min(0).max(9),
    backup: z.boolean().default(false),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ slot, backup, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.loadStateSlot(slot, backup);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Loaded slot ${slot}. paused=${r.paused} (note: pause state reflects what the VM was doing before this call, not what it was when the state was saved)`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_change_disc',
  'Change/load a disc image (ISO path) into the running VM. Requires DebugServer.',
  {
    path: z.string(),
    source: z.enum(['iso', 'disc', 'nodisc']).default('iso'),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ path: discPath, source, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const r = await debugServer!.changeDisc(discPath, source);
        return { content: [{ type: 'text' as const, text: `Changed disc to ${discPath}. paused=${r.paused}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  TOOL: GameDB / Patch Metadata
// ==========================================================
server.tool(
  'pcsx2_get_gamedb_info',
  'PCSX2\'s own compatibility metadata for the running game: compatibility rating, EE/VU0/VU1 rounding & clamp modes (useful if float results look "off" - could be a known rounding quirk, not a bug in your analysis), known gameFixes PCSX2 already applies, and PCSX2\'s own embedded compatibility patch text for this exact CRC if one exists (often names real addresses). Requires DebugServer.',
  {
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const info = await debugServer!.getGameDbInfo();
        if (!info.alive) return { content: [{ type: 'text' as const, text: 'No VM running.' }] };
        if (!info.found)
          return {
            content: [
              { type: 'text' as const, text: "This game is not in PCSX2's GameDB (no known compatibility data)." },
            ],
          };
        const lines = [
          `${info.name} (${info.region}) - compatibility: ${info.compatibility}`,
          `Rounding: EE=${info.ee_round_mode} EE-div=${info.ee_div_round_mode} VU0=${info.vu0_round_mode} VU1=${info.vu1_round_mode}`,
          `Clamping: EE=${info.ee_clamp_mode} VU0=${info.vu0_clamp_mode} VU1=${info.vu1_clamp_mode}`,
        ];
        if (info.game_fixes && info.game_fixes.length > 0)
          lines.push(`Game fixes applied: ${info.game_fixes.join(', ')}`);
        if (info.gamedb_patch) lines.push('', '--- GameDB compatibility patch (pnach) ---', info.gamedb_patch);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

server.tool(
  'pcsx2_list_game_patches',
  'List community-authored pnach patches/cheats for the running game (CRC-matched). Name + description + author only, no raw addresses - but descriptions often hint at what\'s interesting and where (e.g. "Infinite Health", "Unlock All Levels"). Requires DebugServer.',
  {
    cheats: z.boolean().default(true),
    instance_id: z
      .string()
      .optional()
      .describe(
        'Target a specific connected instance by id or fuzzy match on game title/serial/label (see pcsx2_list_instances). Defaults to the currently active instance (pcsx2_use_instance) if omitted.',
      ),
  },
  async ({ cheats, instance_id }) => {
    return withInstance(instance_id, async () => {
      if (!hasDebug())
        return { content: [{ type: 'text' as const, text: 'Error: DebugServer not connected.' }], isError: true };
      try {
        const { unlabelledCount, patches } = await debugServer!.listGamePatches(cheats);
        if (patches.length === 0)
          return { content: [{ type: 'text' as const, text: 'No patches/cheats found for this game.' }] };
        const lines = patches.map(
          (p) => `${p.name}${p.author ? ` (by ${p.author})` : ''}${p.description ? `\n  ${p.description}` : ''}`,
        );
        const note =
          unlabelledCount > 0
            ? `\n(${unlabelledCount} additional unlabelled patch line(s) not shown individually)`
            : '';
        return { content: [{ type: 'text' as const, text: lines.join('\n') + note }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    });
  },
);

// ==========================================================
//  MCP Resources
// ==========================================================
server.resource('ps2_memory_map', 'ps2://memory_map', async () => ({
  contents: [
    {
      uri: 'ps2://memory_map',
      mimeType: 'text/plain',
      text: `PS2 EE Memory Map\n0x00000000-0x01FFFFFF  RDRAM (32MB)\n0x10000000-0x1000FFFF  EE Registers\n0x11000000-0x11FFFFFF  VU0/VU1\n0x12000000-0x12FFFFFF  GS Registers\n0x1C000000-0x1C3FFFFF  IOP RAM (2MB)\n0x1FC00000-0x1FFFFFFF  BIOS ROM (4MB)\n0x70000000-0x70003FFF  Scratchpad (16KB)`,
    },
  ],
}));

server.resource('debug_protocol', 'ps2://debug_protocol', async () => ({
  contents: [
    {
      uri: 'ps2://debug_protocol',
      mimeType: 'text/plain',
      text: `PCSX2 Debug Server Protocol (port 21512)\nNewline-delimited JSON over TCP\n\nCommands: status, read_registers, write_register, set_pc, read_memory, write_memory, read_memory_multiple, read_string, disassemble, evaluate, set_breakpoint, remove_breakpoint, list_breakpoints, set_memcheck, remove_memcheck, list_memchecks, pause, resume, resume_and_wait, step, step_over, get_threads, get_modules, get_backtrace, is_valid_address, clear_breakpoints, resolve_address, find_symbol, get_function_info, list_functions, decode_instruction, assemble, scan_functions, search_memory_start, search_memory_next, search_memory_results, search_memory_reset, get_game_info, reset_vm, frame_advance, save_state_slot, load_state_slot, change_disc, get_gamedb_info, list_game_patches, read_vu1_registers, get_gs_context, read_vu_micromem, disassemble_vu, set_vu_breakpoint, remove_vu_breakpoint, list_vu_breakpoints, clear_vu_breakpoints\n\nRequest:  {"cmd":"read_registers","cpu":"ee","category":0}\\n\nResponse: {"ok":true,"data":{...}}\\n\n\nPause-state contract: every command that can change or depend on run state (pause, resume, resume_and_wait, step, step_over, frame_advance, reset_vm, save_state_slot, load_state_slot, change_disc) includes an explicit "paused" bool in its response - never assume, always read it instead of polling status separately. Two things are easy to get wrong: on step/step_over/frame_advance, "timed_out":true means the VM is still RUNNING (not paused) - the wait gave up before a pause happened. load_state_slot does NOT restore the pause state that was active when the save was made (saves don't carry that) - it only reflects whatever the VM was doing right before the load call. For "resume + wait for a breakpoint to fire", use resume_and_wait instead of resume - plain resume does not tell you when/whether a breakpoint hit.`,
    },
  ],
}));

// ===== MAIN =====
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PCSX2 ULTIMATE MCP Server v2.0 running');
  console.error(`PS2Recomp root: ${PS2RECOMP_ROOT}`);
}
main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

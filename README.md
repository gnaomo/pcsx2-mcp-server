> ## ⚠️ Personal Backup Fork — LLM-Generated Changes
>
> This is a personal backup/development fork of [hkmodd/PCSX2-MCP](https://github.com/hkmodd/PCSX2-MCP), restructured for a Linux workflow and extended with new tools (multi-instance support, VU microcode disassembly/breakpoints, symbol intelligence, memory search, GS state inspection, and more — see [Tools](#tools) below).
>
> The matching patched PCSX2 build lives in a linked submodule: **[gnaomo/pcsx2](https://github.com/gnaomo/pcsx2)**, branch `backup/pcsx2-mcp-debugserver`. Clone with `--recurse-submodules` to get both in sync — see [Quick Start](#quick-start).
>
> **⚠️ LLM disclosure:** everything beyond the original upstream project was written entirely by an LLM (AI coding assistant) and has **not been reviewed, audited, or verified by the repository owner**. Treat it as untrusted / unreviewed. This is a personal backup, not a maintained public project — please use upstream [hkmodd/PCSX2-MCP](https://github.com/hkmodd/PCSX2-MCP) if you want a supported release.

# PCSX2-MCP

> **Control a PS2 emulator from your AI coding assistant.**
> Set breakpoints, read registers, disassemble MIPS *and* VU microcode, inspect memory, search for values, and more — all via MCP tools, across one or several PCSX2 instances at once.

```
  AI Assistant  <--stdio (MCP)-->  pcsx2-mcp-server  <--TCP 21512-->  PCSX2 Emulator
  (Claude etc)                    (Node.js bridge)   <--TCP 28011-->  + DebugServer
                                                                       + Pine IPC
```

- **DebugServer** — custom TCP/JSON server patched into PCSX2 (`pcsx2-fork` submodule), full access: 128-bit registers, native MIPS *and* VU disassembly, expressions, conditional breakpoints, symbol lookup, memory search, save states.
- **Pine IPC** — PCSX2's built-in IPC, used as a fallback (memory R/W, game info, save states) when DebugServer isn't available. Unix socket on Linux/macOS, TCP on Windows — handled automatically.

---

## Quick Start

```bash
# 1. Clone this repo AND the matching patched PCSX2 fork together
git clone --recurse-submodules https://github.com/gnaomo/pcsx2-mcp-server.git
cd pcsx2-mcp-server

# 2. Build PCSX2 (the DebugServer patch is already applied in pcsx2-fork/)
cd pcsx2-fork
cmake --preset linux-x64  # or your platform's preset — see PCSX2's own build docs
cmake --build build -j$(nproc) --target pcsx2-qt
cd ..

# 3. Build the MCP server
cd pcsx2-mcp-server
npm install
npm run build
cd ..
```

Then point any MCP-compatible client (Claude Desktop, VS Code, etc.) at `pcsx2-mcp-server/dist/index.js`:

```json
{
  "mcpServers": {
    "pcsx2": {
      "command": "node",
      "args": ["<repo-path>/pcsx2-mcp-server/dist/index.js"]
    }
  }
}
```

Launch the freshly-built `pcsx2-fork/build/bin/pcsx2-qt`, load a game, restart your AI assistant, and ask it to connect. You'll see `[DebugServer] Listening on 127.0.0.1:21512` in PCSX2's console once it's up.

> Already have a working PCSX2 checkout with the patch applied elsewhere? Skip the submodule — copy `pcsx2-fork/pcsx2/DebugTools/DebugServer.{cpp,h}` into your own tree's `pcsx2/DebugTools/` and wire it into `CMakeLists.txt` + `VMManager.cpp` (start/stop calls) as shown there.

---

## Tools

62 MCP tools across these areas:

| Area | Examples | Count |
|---|---|---|
| **Connection & multi-instance** | `pcsx2_connect`, `pcsx2_list_instances`, `pcsx2_use_instance`, `pcsx2_discover_instances`, `pcsx2_forget_instance`, `pcsx2_status` | 6 |
| **Memory** | `pcsx2_read_memory`, `pcsx2_read_memory_multiple` (batched), `pcsx2_write_memory`, `pcsx2_read_string`, `pcsx2_find_pattern`, `pcsx2_memory_diff` | 6 |
| **Memory search** | Cheat-Engine-style value scanner: `pcsx2_search_memory_start/next/results/reset` | 4 |
| **Registers** | `pcsx2_read_registers` (GPR/CP0/FPU/VU0/VU1/GS, full 128-bit), `pcsx2_write_register`, `pcsx2_read_vu1_registers` | 3 |
| **MIPS disassembly & code analysis** | `pcsx2_disassemble`, `pcsx2_evaluate`, `pcsx2_decode_instruction`, `pcsx2_assemble`, `pcsx2_scan_functions` | 5 |
| **VU microcode** *(new)* | `pcsx2_read_vu_micromem`, `pcsx2_disassemble_vu` (real upper/lower-pipeline VU disasm, not MIPS), `pcsx2_set/remove/list/clear_vu_breakpoint(s)` | 6 |
| **Symbol intelligence** *(new)* | `pcsx2_resolve_address`, `pcsx2_find_symbol`, `pcsx2_get_function_info`, `pcsx2_list_functions` | 4 |
| **Breakpoints & watchpoints** | `pcsx2_set/remove/list_breakpoint`, `pcsx2_set/remove/list_watchpoint` (read/write/access/onChange), `pcsx2_clear_all_breakpoints` | 7 |
| **Execution control** | `pcsx2_step`, `pcsx2_step_over`, `pcsx2_continue`, `pcsx2_resume_and_wait` *(new — blocks until a breakpoint actually fires)*, `pcsx2_pause`, `pcsx2_frame_advance` | 6 |
| **GS / graphics** *(new)* | `pcsx2_get_gs_context` (full drawing-context dump); `pcsx2_get_screenshot` implemented but disabled pending client-side image rendering support | 1 active |
| **VM & session control** | `pcsx2_reset_vm`, `pcsx2_save/load_state_slot`, `pcsx2_change_disc` | 4 |
| **GameDB / patches** *(new)* | `pcsx2_get_gamedb_info` (rounding/clamp modes, known game fixes), `pcsx2_list_game_patches` | 2 |
| **System** | `pcsx2_get_threads`, `pcsx2_get_modules`, `pcsx2_get_backtrace`, `pcsx2_game_info`, `pcsx2_save_state`, `pcsx2_load_state` (Pine) | 6 |
| **PS2Recomp integration** | `ps2recomp_lookup_function`, `ps2recomp_list_overrides` | 2 |

Full descriptions and parameters are in each tool's own docstring in `pcsx2-mcp-server/src/index.ts` — kept there rather than duplicated here so they can't drift out of sync.

### Known limitations
- **VU breakpoints only fire under PCSX2's interpreter**, not the default microVU JIT recompiler — disable "Enable VU0/VU1 Recompiler" (System → Emulation) for whichever VU you're investigating if a breakpoint silently never hits.
- **Watchpoints only see CPU load/store instructions** — DMAC transfers (VIF/GIF/SIF/IPU) bypass them entirely, which is most PS2 texture/VU-chain data movement.
- **Multi-instance** is "select the active instance, then act" (`pcsx2_use_instance`), not per-call instance targeting — see `ROADMAP.md` (local, not included in this backup) for the fuller per-call design.

---

## Example workflows

```
> "Connect to PCSX2, disassemble 40 instructions at 0x001000E0"
> "Set a breakpoint at 0x001000E0 with condition v0 == 5, then resume and wait"
> "Set a VU0 breakpoint where vcallms jumps to, then disassemble the VU microcode there"
> "Search memory for u32 values that increased after I picked up the item"
> "Get the GS context — what texture format is the active draw context using?"
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| DebugServer not listening | Check PCSX2's console for `[DebugServer] Listening on 127.0.0.1:21512` |
| "No connection" from tools | Call `pcsx2_connect` first (or `pcsx2_discover_instances` for multiple) |
| Pine tools fail | Enable Pine IPC: PCSX2 Settings → Advanced → Enable Pine IPC |
| Breakpoints don't trigger | Game must be running, not in BIOS/menu; for VU breakpoints see the limitation above |
| VU breakpoint never fires | Disable that VU's recompiler (System → Emulation) — see limitation above |

---

## License

- **PCSX2**: GPL-3.0 (same as [upstream](https://github.com/PCSX2/pcsx2))
- **DebugServer patch**: GPL-3.0 (derivative work) — source in `pcsx2-fork` submodule at `pcsx2/DebugTools/DebugServer.{cpp,h}`, and mirrored standalone in `pcsx2-plugin/`
- **MCP Server**: MIT

Upstream project: [hkmodd/PCSX2-MCP](https://github.com/hkmodd/PCSX2-MCP). Unmodified PCSX2 source: [github.com/PCSX2/pcsx2](https://github.com/PCSX2/pcsx2).

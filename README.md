# Verilog/SystemVerilog Full Support for VS Code

This extension provides comprehensive support for Verilog and SystemVerilog development, featuring:

- ✅ Syntax highlighting (TextMate grammar)
- ✅ Code snippets
- ✅ Real-time linting with Verilator (SARIF‑based, with cross‑file diagnostics)
- ✅ **Three independent module dependency tree views** (Source, Simulation, SoC)
- ✅ **Module instantiation assistant** (command palette + autocompletion)
- ✅ **Cyclic dependency detection** and reporting
- ✅ **Duplicate module/package/interface definition detection**
- ✅ **Incremental scanning** (only re‑parse changed files)
- ✅ **Persistent dependency cache** (speeds up reload)
- ✅ **Hover information** for signals, ports, parameters, and Verilator warnings/errors
- ✅ **Document symbols outline** (modules, interfaces, tasks, functions, generate blocks, etc.)
- ✅ **Go to definition** for modules, ports, parameters, and local signals
- ✅ **Autocompletion** for module names (with instantiation), ports, and parameters

## Features

### 1. Module Dependency Tree Views

The extension maintains three separate tree views in the activity bar (under the **Verilog** icon):

- **Module Dependencies** – shows the dependency graph for your source files (`verilog.srcFolders`).
- **Simulation Files** – isolated view for simulation‑related files (`verilog.simFolders`).
- **SoC Files** – separate view for System‑on‑Chip files (`verilog.socFolders`).

Each view is independently configurable and can be refreshed with a button in the view title bar.

**What you see in the tree:**

- **Top‑level modules** (modules that are never instantiated) are listed first.
- **Starred top module** – you can right‑click any top‑level module and select “Set as Top”. That module will be marked with a star and moved to the top of the list.
- **Expanding a module** shows its dependencies (instantiated modules, interfaces, and imported packages).
- **Icons** indicate the kind of node:
  - 📦 Package (`library` icon)
  - 🔌 Interface (`symbol-interface`)
  - 🧩 Module (`symbol-module`)
  - ❓ Unresolved module (`error` red)
  - ⚠️ Module involved in a cycle (`warning` orange)
  - ⭐ Top‑level module (`star-full`)

### 2. Module Instantiation Assistant

You can instantiate a module in two ways:

- **Via command palette or context menu** – select a module from a quick‑pick list, and a fully formatted instantiation template is inserted at the cursor.
- **Via autocompletion** – start typing the module name, choose from the dropdown, and the instantiation is generated automatically.

**Generated code includes:**

- `localparam` declarations for each parameter (using the parameter’s default value if available, otherwise the parameter name).
- Declarations for all **output** ports, with proper type and width alignment (aligned to multiples of 4 columns).
- A comment `// output from u_<module>` before the output declarations.
- A correctly formatted instantiation with:
  - Parameters (if any) and ports aligned in two columns: the `.port` on the left, the `( connection )` on the right.
  - The opening and closing parentheses aligned to multiples of 4 columns.
  - The entire block indented to the cursor column.

The alignment respects the column of the cursor, so the code blends seamlessly with your existing indentation.

### 3. Autocompletion

- **Module name completion** – triggered as you type letters. Select a module to instantly generate a full instantiation.
- **Port and parameter completion** – after typing `.` inside a module instantiation (e.g., `u_module .`), a list of all ports (or parameters if inside `#(...)`) appears. Choosing an item inserts a correctly aligned connection line (e.g., `.port( port )`). The alignment is based on the longest port/parameter name and value to keep all connections neatly aligned.

### 4. Document Symbols Outline

The Outline view (Ctrl+Shift+O) shows all structural elements of the current file:

- Modules, interfaces, packages
- Tasks and functions
- Generate blocks (named generate regions)
- Ports, parameters, local signals (wire/reg/logic), and genvars
- Instantiations (module, interface, checker)
- Package imports and typedefs

Clicking any symbol jumps to its declaration.

### 5. Hover Information

Hover over any identifier to see:

- For signals (ports, wires, regs, logic, genvars): type and packed/unpacked dimensions.
- For parameters: parameter kind (`parameter` or `localparam`) and its default value.
- For modules (when hovering an instance name): the module name and the file where it is defined.
- For Verilator diagnostics: a detailed description of the warning/error code.

### 6. Go to Definition

Hold Ctrl (or Cmd) and click on:

- **Module instance name** – jumps to the module definition (cross‑file).
- **Port, parameter, or local signal** – jumps to its declaration within the same file.
- **Task or function name** – jumps to its definition.

### 7. Cyclic Dependency Detection

The scanner builds a directed graph of module instantiations and detects cycles. When a cycle is found:

- A warning appears in the **Verilog Cyclic Dependencies** output channel (one per view).
- All modules in the cycle are marked with a warning icon in the tree view.

### 8. Duplicate Definition Detection

If the same module, package, or interface is defined in more than one file:

- Error diagnostics are added to **each** definition location, pointing to the other definition(s).
- The duplicates are listed in the **Verilog Duplicate Definitions** output channel.

### 9. Incremental Scanning & Persistent Cache

The scanner monitors files in the configured folders and re‑parses only those that have changed.

- A timer (default 1 second) triggers incremental scans.
- The dependency data is automatically saved to `.vscode/verilog-deps-<view>.json` files.
- On next workspace load, the cache is loaded immediately, so the tree views appear instantly. A background scan then verifies if any file changed and updates accordingly.
- You can disable caching or choose whether to be asked before creating the cache file.

### 10. Verilator Linting

The extension runs Verilator in **--lint-only** mode using the **SARIF** output format, which provides precise source locations and eliminates the need for brittle text parsing.

- **Trigger modes:** `onSave` or `onType` (configurable).
- **Diagnostics** (errors/warnings) appear as squiggles in the editor, covering the exact range of the relevant identifier.
- **Hover** over a diagnostic to see a detailed description of the error/warning code (e.g., `%Warning-WIDTH` → detailed explanation).
- **Cross‑file diagnostics** (enabled by default): all files mentioned in the lint output receive diagnostics, even if they are not currently open.
- **Clear before lint** (enabled by default): previous diagnostics are cleared before each lint run, avoiding stale markers.

### 11. Configuration Options

All settings can be changed in VS Code’s settings UI or in `settings.json`.

| Setting | Description | Default |
|---------|-------------|---------|
| `verilog.path` | Path to the Verilator executable | `"verilator"` |
| `verilog.includePath` | List of include directories (`-I`) | `[]` |
| `verilog.lint.arguments` | Additional arguments for Verilator | `["-Wall"]` |
| `verilog.lint.enable` | Enable/disable linting | `true` |
| `verilog.lint.run` | `"onSave"` or `"onType"` | `"onSave"` |
| `verilog.lint.clearBeforeLint` | Clear old diagnostics before each lint run | `true` |
| `verilog.lint.crossFileDiagnostics` | Show diagnostics for all files in lint output | `true` |
| `verilog.srcFolders` | Root folders for source view | `[]` (uses workspace root if empty) |
| `verilog.simFolders` | Root folders for simulation view | `[]` |
| `verilog.socFolders` | Root folders for SoC view | `[]` |
| `verilog.dependencyScanEnable` | Enable dependency scanning | `true` |
| `verilog.dependencyScanInterval` | Interval (ms) between scans | `1000` |
| `verilog.dependencyScan.useRegex` | Force regex parsing (fallback) | `false` |
| `verilog.dependencyCache.enable` | Save/load dependency cache | `true` |
| `verilog.dependencyCache.askBeforeCreate` | Ask before creating cache file | `true` |
| `verilog.dependencyCache.directory` | Directory (relative to workspace root) for cache | `".vscode"` |

## Usage Examples

### Set up the folders

In your workspace settings (`.vscode/settings.json`), define the source, simulation, and SoC directories:

```json
{
    "verilog.srcFolders": ["rtl"],
    "verilog.simFolders": ["tb"],
    "verilog.socFolders": ["soc"]
}
```

### Instantiate a module via autocompletion

1. Start typing a module name (e.g., `cou`). A dropdown with matching modules appears.
2. Select the desired module (e.g., `counter`). The full instantiation code is inserted, replacing the typed prefix.
3. The generated code includes parameters, output declarations, and a correctly aligned instance.

### Use port autocompletion

1. After an instance name, type a dot and a space (e.g., `u_counter .`). A list of all ports appears.
2. Select a port (e.g., `clk`). A properly aligned connection line `.clk( clk )` is inserted, aligned with existing connections.

### Set a top module

1. In any tree view, locate a top‑level module (one with no parent).
2. Right‑click it and choose **Set as Top**.
3. The module gets a star and moves to the top of the list.

### Detect cycles

Open the **Verilog Cyclic Dependencies** output channel. If any cycles exist, they will be listed there and the involved modules will have a warning icon in the tree.

### See duplicate definitions

The **Verilog Duplicate Definitions** output channel lists all duplicate names and their locations. Error markers appear in the editor at each definition.

## Requirements

- **Verilator** (version 5.008 or later, because SARIF output is used) must be installed and accessible from the command line.

  - Linux: `sudo apt install verilator`
  - macOS: `brew install verilator`
  - Windows: Use WSL or download from [Veripool](https://www.veripool.org/verilator/)

## Extension Commands

| Command | Description |
|---------|-------------|
| `verilog.lintCurrentFile` | Manually lint the current file |
| `verilog.refreshModuleTree` | Refresh the Module Dependencies view |
| `verilog.refreshSimTree` | Refresh the Simulation Files view |
| `verilog.refreshSocTree` | Refresh the SoC Files view |
| `verilog.setAsTopSrc` | Set the selected module as top (Source view) |
| `verilog.setAsTopSim` | Set the selected module as top (Simulation view) |
| `verilog.setAsTopSoc` | Set the selected module as top (SoC view) |
| `verilog.instantiateSrcModule` | Instantiate a module from the Source view (manual pick) |
| `verilog.instantiateSimModule` | Instantiate a module from the Simulation view (manual pick) |
| `verilog.instantiateSocModule` | Instantiate a module from the SoC view (manual pick) |

All commands are available from the command palette (`Ctrl+Shift+P`). Instantiation commands also appear in the context menu of the editor, and module autocompletion is integrated into the editor.

## Known Limitations

- **Regular expression fallback** is limited – it only captures module names and simple instantiations, without parameters, ports, or package imports. It is only used when tree‑sitter parsing fails.
- **Tree‑sitter parser** is required for full functionality (parameter/port extraction, package import resolution, interface instantiation). The parser is included in the extension (the WASM file is inside `syntaxes/`).
- **Custom types** (e.g., `typedef struct`) are not yet fully analyzed; they appear as simple types in ports.
- **Linting** uses the SARIF output format, which requires Verilator 5.008 or later. If an older Verilator is used, the linting will fall back to text parsing (which may be less accurate).

## Contributing

Contributions are welcome! Please open an issue or pull request on [GitHub](https://github.com/Liu-Bingxu/vscode-verilog-systemverilog).

## License

[MIT](LICENSE)

---

**Enjoy productive Verilog/SystemVerilog development!**
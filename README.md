# Verilog/SystemVerilog Full Support for VS Code

This extension provides comprehensive support for Verilog and SystemVerilog development, featuring:

- ✅ Syntax highlighting (TextMate grammar)
- ✅ Code snippets
- ✅ Real-time linting with Verilator (with cross‑file diagnostics)
- ✅ **Three independent module dependency tree views** (Source, Simulation, SoC)
- ✅ **Module instantiation assistant** with configurable formatting
- ✅ **Cyclic dependency detection** and reporting
- ✅ **Duplicate module/package/interface definition detection**
- ✅ **Incremental scanning** (only re‑parse changed files)
- ✅ **Persistent dependency cache** (speeds up reload)
- ✅ **Hover information** for Verilator warning/error codes

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

When you right‑click in a Verilog/SystemVerilog file and select **Verilog: Instantiate Module** (or use the command palette), the extension will:

- Present a quick‑pick list of all modules available in the **current view** (Source/Simulation/SoC).
- Once you select a module, it generates a fully formatted instantiation template, inserted at the cursor position.

**Generated code includes:**

- `localparam` declarations for each parameter (using the parameter’s own name as default value).
- Declarations for all **output** ports, with proper type and width alignment (aligned to multiples of 4 columns).
- A comment `// output from u_<module>` before the output declarations.
- A correctly formatted instantiation with:
  - Parameters (if any) and ports aligned in two columns: the `.port` on the left, the `( connection )` on the right.
  - The opening and closing parentheses aligned to multiples of 4 columns.
  - The entire block indented to the cursor column.

The alignment respects the column of the cursor, so the code blends seamlessly with your existing indentation.

### 3. Cyclic Dependency Detection

The scanner builds a directed graph of module instantiations and detects cycles. When a cycle is found:

- A warning appears in the **Verilog Cyclic Dependencies** output channel (one per view).
- All modules in the cycle are marked with a warning icon in the tree view.

### 4. Duplicate Definition Detection

If the same module, package, or interface is defined in more than one file:

- Error diagnostics are added to **each** definition location, pointing to the other definition(s).
- The duplicates are listed in the **Verilog Duplicate Definitions** output channel.

### 5. Incremental Scanning & Persistent Cache

The scanner monitors files in the configured folders and re‑parses only those that have changed.

- A timer (default 1 second) triggers incremental scans.
- The dependency data is automatically saved to `.vscode/verilog-deps-<view>.json` files.
- On next workspace load, the cache is loaded immediately, so the tree views appear instantly. A background scan then verifies if any file changed and updates accordingly.
- You can disable caching or choose whether to be asked before creating the cache file.

### 6. Verilator Linting

The extension can run Verilator in **--lint-only** mode on your Verilog/SystemVerilog files.

- **Trigger modes:** `onSave` or `onType` (configurable).
- **Diagnostics** (errors/warnings) appear as squiggles in the editor.
- **Hover** over a diagnostic to see a description of the error/warning code (e.g., `%Warning-WIDTH` → detailed explanation).
- **Cross‑file diagnostics** (enabled by default): all files mentioned in the lint output receive diagnostics, even if they are not currently open.
- **Clear before lint** (enabled by default): previous diagnostics are cleared before each lint run, avoiding stale markers.

### 7. Configuration Options

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

### Instantiate a module

1. Place the cursor where you want the instantiation.
2. Right‑click → **Verilog: Instantiate Module (Source)** (or use the command palette).
3. Select a module from the list.
4. The formatted code is inserted, respecting the cursor column.

### Set a top module

1. In any tree view, locate a top‑level module (one with no parent).
2. Right‑click it and choose **Set as Top**.
3. The module gets a star and moves to the top of the list.

### Detect cycles

Open the **Verilog Cyclic Dependencies** output channel. If any cycles exist, they will be listed there and the involved modules will have a warning icon in the tree.

### See duplicate definitions

The **Verilog Duplicate Definitions** output channel lists all duplicate names and their locations. Error markers appear in the editor at each definition.

## Requirements

- **Verilator** (version 4.0 or later) must be installed and accessible from the command line.

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
| `verilog.instantiateSrcModule` | Instantiate a module from the Source view |
| `verilog.instantiateSimModule` | Instantiate a module from the Simulation view |
| `verilog.instantiateSocModule` | Instantiate a module from the SoC view |

All commands are available from the command palette (`Ctrl+Shift+P`), and instantiation commands also appear in the context menu of the editor.

## Known Limitations

- **Regular expression fallback** is limited – it only captures module names and simple instantiations, without parameters, ports, or package imports.
- **Tree‑sitter parser** is required for full functionality (parameter/port extraction, package import resolution, interface instantiation). The parser is included in the extension (the WASM file is inside `syntaxes/`).
- **Custom types** (e.g., `typedef struct`) are not yet analyzed; they appear as simple types in ports.
- **Linting** only runs on the currently edited file, but can propagate diagnostics to other files if cross‑file diagnostics is enabled.

## Contributing

Contributions are welcome! Please open an issue or pull request on [GitHub](https://github.com/your-username/vscode-verilog-full).

## License

[MIT](LICENSE)
